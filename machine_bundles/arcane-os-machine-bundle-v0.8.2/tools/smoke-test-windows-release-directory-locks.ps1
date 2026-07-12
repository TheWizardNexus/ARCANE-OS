$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class ArcaneDirectoryLockProbe : IDisposable
{
    private const uint FileReadAttributes = 0x00000080;
    private const uint FileListDirectory = 0x00000001;
    private const uint FileShareRead = 0x00000001;
    private const uint OpenExisting = 3;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private SafeFileHandle handle;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation information);

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        internal uint FileAttributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        internal uint VolumeSerialNumber;
        internal uint FileSizeHigh;
        internal uint FileSizeLow;
        internal uint NumberOfLinks;
        internal uint FileIndexHigh;
        internal uint FileIndexLow;
    }

    public bool IsReparsePoint { get; private set; }

    public ArcaneDirectoryLockProbe(string path)
    {
        handle = CreateFile(
            Path.GetFullPath(path), FileReadAttributes | FileListDirectory, FileShareRead, IntPtr.Zero,
            OpenExisting, FileFlagBackupSemantics | FileFlagOpenReparsePoint, IntPtr.Zero);
        if (handle == null || handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        ByHandleFileInformation information;
        if (!GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
        FileAttributes attributes = (FileAttributes)information.FileAttributes;
        if ((attributes & FileAttributes.Directory) == 0) throw new InvalidDataException("Probe path is not a directory.");
        IsReparsePoint = (attributes & FileAttributes.ReparsePoint) != 0;
    }

    public void Dispose()
    {
        if (handle != null) handle.Dispose();
        handle = null;
    }
}
'@

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$sandbox = [IO.Path]::GetFullPath((Join-Path $tempRoot ('arcane-directory-lock-' + [Guid]::NewGuid().ToString('N'))))
if (-not $sandbox.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe Arcane lock-smoke sandbox path.' }
$release = Join-Path $sandbox 'release'
$app = Join-Path $release 'app'
$shell = Join-Path $app 'shell'
$real = Join-Path $sandbox 'real-directory'
$junction = Join-Path $sandbox 'junction-directory'
$locks = New-Object 'System.Collections.Generic.List[IDisposable]'

try {
  New-Item -ItemType Directory -Path $shell -Force | Out-Null
  New-Item -ItemType Directory -Path $real -Force | Out-Null
  New-Item -ItemType Junction -Path $junction -Target $real | Out-Null
  $junctionProbe = New-Object ArcaneDirectoryLockProbe($junction)
  try {
    if (-not $junctionProbe.IsReparsePoint) { throw 'The native directory probe failed to identify a junction reparse point.' }
  } finally { $junctionProbe.Dispose() }

  foreach ($directory in @($release, $app, $shell)) { $locks.Add((New-Object ArcaneDirectoryLockProbe($directory))) }
  foreach ($move in @(
    @{Source=$shell;Destination=(Join-Path $app 'shell-moved')},
    @{Source=$release;Destination=(Join-Path $sandbox 'release-moved')}
  )) {
    $moved = $false
    try { Move-Item -LiteralPath $move.Source -Destination $move.Destination -ErrorAction Stop; $moved = $true } catch { }
    if ($moved) { throw "Windows renamed a release directory despite its retained deny-delete handle: $($move.Source)" }
    if (-not (Test-Path -LiteralPath $move.Source -PathType Container)) { throw 'The failed rename did not preserve the original release directory.' }
  }

  foreach ($lock in $locks) { $lock.Dispose() }
  $locks.Clear()
  $movedRelease = Join-Path $sandbox 'release-moved'
  Move-Item -LiteralPath $release -Destination $movedRelease -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $movedRelease -PathType Container)) { throw 'The release directory did not become movable after lock disposal.' }
  Write-Host 'Windows release directory handles blocked root/subdirectory rename and exposed junction reparse identity.'
} finally {
  foreach ($lock in $locks) { try { $lock.Dispose() } catch { } }
  if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
}
