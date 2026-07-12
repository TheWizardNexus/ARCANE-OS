using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ArcaneOS
{
    internal static class Program
    {
#if ARCANE_TARGET_APP
        internal const string AppMode = ArcaneTarget.AppMode;
        internal const string ProductName = ArcaneTarget.ProductName;
        internal const string AppId = ArcaneTarget.AppId;
        internal const bool AllowMicrophone = ArcaneTarget.AllowMicrophone;
        internal static readonly string[] AllowedNavigationPaths = ArcaneTarget.AllowedNavigationPaths;
#elif ARCANE_SHELL
        internal const string AppMode = "shell";
        internal const string ProductName = "Arcane OS";
        internal const string AppId = "Arcane.OS.Shell";
        internal const bool AllowMicrophone = true;
#else
        internal const string AppMode = "provisioner";
        internal const string ProductName = "Arcane OS Provisioner";
        internal const string AppId = "Arcane.OS.Provisioner";
        internal const bool AllowMicrophone = false;
#endif
        private static Mutex instanceMutex;

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int SetCurrentProcessExplicitAppUserModelID(string appID);

        [STAThread]
        private static void Main(string[] args)
        {
            if (ShellWatchdog.TryRun(args)) return;

            bool created;
            instanceMutex = new Mutex(true, "Local\\" + AppId + ".SingleInstance", out created);
            if (!created) return;

            ReleaseSecurityResult releaseSecurity = null;
            try
            {
                releaseSecurity = ReleaseSecurityVerifier.Verify(args);
                if (AppMode == "shell") ShellWatchdog.Start();
                try { SetCurrentProcessExplicitAppUserModelID(AppId); } catch { }
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs eventArgs)
                {
                    if (AppMode == "shell") EmergencyDesktop.TryStart();
                    MessageBox.Show(eventArgs.Exception.ToString(), "Arcane stopped unexpectedly", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Application.Exit();
                };
                AppDomain.CurrentDomain.UnhandledException += delegate
                {
                    if (AppMode == "shell") EmergencyDesktop.TryStart();
                };
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new ArcaneForm(args, releaseSecurity));
            }
            catch (Exception error)
            {
                if (AppMode == "shell") EmergencyDesktop.TryStart();
                MessageBox.Show(error.ToString(), "Arcane could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                if (releaseSecurity != null) releaseSecurity.Dispose();
                GC.KeepAlive(instanceMutex);
            }
        }
    }

    internal static class ShellWatchdog
    {
        private const string WatchdogArgument = "--arcane-shell-watchdog";
        private const string EventPrefix = "Local\\Arcane.OS.Shell.Watchdog.";
        private static EventWaitHandle disarmEvent;
        private static Process watchdogProcess;
        private static int disarmed;

        internal static bool TryRun(string[] args)
        {
            if (Program.AppMode != "shell" || args == null || args.Length == 0
                || !String.Equals(args[0], WatchdogArgument, StringComparison.Ordinal)) return false;

            try { Run(args); }
            catch { }
            return true;
        }

        internal static void Start()
        {
            if (Program.AppMode != "shell" || disarmEvent != null) return;

            string token = Guid.NewGuid().ToString("N");
            string disarmName = EventPrefix + token + ".Disarm";
            string readyName = EventPrefix + token + ".Ready";
            bool disarmCreated;
            bool readyCreated;
            EventWaitHandle localDisarm = null;
            EventWaitHandle ready = null;
            Process child = null;
            try
            {
                using (Process current = Process.GetCurrentProcess())
                {
                    localDisarm = new EventWaitHandle(false, EventResetMode.ManualReset, disarmName, out disarmCreated);
                    ready = new EventWaitHandle(false, EventResetMode.ManualReset, readyName, out readyCreated);
                    if (!disarmCreated || !readyCreated) throw new InvalidOperationException("Arcane could not create private shell-watchdog synchronization events.");

                    ProcessStartInfo start = new ProcessStartInfo(Application.ExecutablePath)
                    {
                        Arguments = WatchdogArgument + " "
                            + current.Id.ToString(CultureInfo.InvariantCulture) + " "
                            + current.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) + " "
                            + disarmName + " " + readyName,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden,
                        WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory
                    };
                    child = Process.Start(start);
                    if (child == null) throw new InvalidOperationException("Windows did not start the Arcane shell watchdog.");
                    if (!ready.WaitOne(TimeSpan.FromSeconds(5)) || child.HasExited)
                        throw new InvalidOperationException("The Arcane shell watchdog did not confirm that it is monitoring this shell.");

                    disarmEvent = localDisarm;
                    watchdogProcess = child;
                    localDisarm = null;
                    child = null;
                    watchdogProcess.EnableRaisingEvents = true;
                    watchdogProcess.Exited += delegate
                    {
                        if (Volatile.Read(ref disarmed) == 0) EmergencyDesktop.TryStart();
                    };
                    if (watchdogProcess.HasExited)
                        throw new InvalidOperationException("The Arcane shell watchdog exited immediately after its startup handshake.");
                }
            }
            finally
            {
                if (child != null)
                {
                    try { if (!child.HasExited) child.Kill(); } catch { }
                    try { child.Dispose(); } catch { }
                }
                if (localDisarm != null) localDisarm.Dispose();
                if (ready != null) ready.Dispose();
            }
        }

        internal static void Disarm()
        {
            if (Interlocked.Exchange(ref disarmed, 1) != 0) return;
            try { if (disarmEvent != null) disarmEvent.Set(); } catch { }
            try { if (disarmEvent != null) disarmEvent.Dispose(); } catch { }
            try { if (watchdogProcess != null) watchdogProcess.Dispose(); } catch { }
            disarmEvent = null;
            watchdogProcess = null;
        }

        private static void Run(string[] args)
        {
            if (args.Length != 5) throw new ArgumentException("Invalid Arcane shell watchdog arguments.");
            int parentId;
            long expectedStartTicks;
            if (!Int32.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out parentId) || parentId <= 0)
                throw new ArgumentException("Invalid Arcane shell watchdog parent process.");
            if (!Int64.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out expectedStartTicks) || expectedStartTicks <= 0)
                throw new ArgumentException("Invalid Arcane shell watchdog process identity.");
            ValidateEventName(args[3]);
            ValidateEventName(args[4]);

            using (EventWaitHandle disarm = EventWaitHandle.OpenExisting(args[3]))
            using (EventWaitHandle ready = EventWaitHandle.OpenExisting(args[4]))
            using (Process parent = Process.GetProcessById(parentId))
            {
                if (parent.StartTime.ToUniversalTime().Ticks != expectedStartTicks)
                    throw new InvalidOperationException("Arcane shell watchdog rejected a reused process identifier.");
                ready.Set();
                while (true)
                {
                    if (disarm.WaitOne(250)) return;
                    if (!parent.WaitForExit(0)) continue;
                    if (!disarm.WaitOne(0)) EmergencyDesktop.TryStart();
                    return;
                }
            }
        }

        private static void ValidateEventName(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || !value.StartsWith(EventPrefix, StringComparison.Ordinal)
                || value.Length > 160 || !Regex.IsMatch(value, @"^Local\\Arcane[.]OS[.]Shell[.]Watchdog[.][a-f0-9]{32}[.](Disarm|Ready)$", RegexOptions.CultureInvariant))
                throw new ArgumentException("Invalid Arcane shell watchdog event name.");
        }
    }

    internal static class EmergencyDesktop
    {
        private static int started;

        internal static void TryStart()
        {
            if (Program.AppMode != "shell" || Interlocked.Exchange(ref started, 1) != 0) return;
            bool launched = false;
            try
            {
                string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
                string explorer = Path.Combine(windows, "explorer.exe");
                if (!Path.IsPathRooted(explorer) || !File.Exists(explorer)) return;
                Process.Start(new ProcessStartInfo(explorer)
                {
                    UseShellExecute = false,
                    WorkingDirectory = windows,
                    CreateNoWindow = false
                });
                launched = true;
            }
            catch { }
            finally
            {
                if (launched) ShellWatchdog.Disarm();
            }
        }
    }

    internal sealed class ReleaseSecurityResult : IDisposable
    {
        private readonly List<FileStream> retainedFiles;
        private readonly List<RetainedDirectoryHandle> retainedDirectories;
        internal string ReleaseRoot { get; private set; }
        internal string SecurityMode { get; private set; }
        internal bool IsUnsignedLocalTest { get { return String.Equals(SecurityMode, "unsigned-local-test", StringComparison.Ordinal); } }

        internal ReleaseSecurityResult(
            string releaseRoot,
            string securityMode,
            List<FileStream> verifiedFiles,
            List<RetainedDirectoryHandle> verifiedDirectories)
        {
            if (String.IsNullOrWhiteSpace(releaseRoot)) throw new ArgumentException("A verified release root is required.", "releaseRoot");
            if (securityMode != "publisher-verified" && securityMode != "unsigned-local-test") throw new ArgumentException("Invalid Arcane release security mode.", "securityMode");
            ReleaseRoot = releaseRoot;
            SecurityMode = securityMode;
            retainedFiles = verifiedFiles ?? new List<FileStream>();
            retainedDirectories = verifiedDirectories ?? new List<RetainedDirectoryHandle>();
        }

        public void Dispose()
        {
            foreach (FileStream file in retainedFiles)
            {
                try { file.Dispose(); } catch { }
            }
            retainedFiles.Clear();
            foreach (RetainedDirectoryHandle directory in retainedDirectories)
            {
                try { directory.Dispose(); } catch { }
            }
            retainedDirectories.Clear();
        }
    }

    internal sealed class RetainedDirectoryHandle : IDisposable
    {
        internal SafeFileHandle Handle { get; private set; }
        internal string ExpectedPath { get; private set; }
        internal uint VolumeSerialNumber { get; private set; }
        internal ulong FileIndex { get; private set; }

        internal RetainedDirectoryHandle(SafeFileHandle handle, string expectedPath, uint volumeSerialNumber, ulong fileIndex)
        {
            Handle = handle;
            ExpectedPath = expectedPath;
            VolumeSerialNumber = volumeSerialNumber;
            FileIndex = fileIndex;
        }

        public void Dispose()
        {
            if (Handle != null) Handle.Dispose();
            Handle = null;
        }
    }

    internal static class ReleaseSecurityVerifier
    {
        private const string BindingMetadataKey = "ArcaneContentBinding";
        private const string MachineManifestName = "arcane-machine-content.json";
        private const string TargetManifestName = "arcane-app-content.json";
        private static readonly Regex HashPattern = new Regex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
        private static readonly Regex AppIdPattern = new Regex("^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", RegexOptions.CultureInvariant);
        private static readonly Regex ReservedNamePattern = new Regex("^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.].*)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private const uint FileReadAttributes = 0x00000080;
        private const uint FileListDirectory = 0x00000001;
        private const uint FileShareRead = 0x00000001;
        private const uint OpenExisting = 3;
        private const uint FileFlagOpenReparsePoint = 0x00200000;
        private const uint FileFlagBackupSemantics = 0x02000000;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation information);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandle(
            SafeFileHandle file,
            StringBuilder filePath,
            uint filePathLength,
            uint flags);

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

        internal static ReleaseSecurityResult Verify(string[] args)
        {
            string executable = Path.GetFullPath(Application.ExecutablePath);
            string executableDirectory = Path.GetDirectoryName(executable);
            if (String.IsNullOrWhiteSpace(executableDirectory)) throw new InvalidOperationException("Arcane could not resolve its native host directory.");
#if ARCANE_TARGET_APP
            string root = executableDirectory;
            string manifestName = TargetManifestName;
            string expectedPrefix = "ARCANE-TARGET-BINDING|1|" + Program.AppMode + "|";
#else
            DirectoryInfo parent = Directory.GetParent(executableDirectory);
            if (parent == null) throw new InvalidOperationException("Arcane could not resolve the release root above bin.");
            string root = parent.FullName;
            string manifestName = MachineManifestName;
            string expectedPrefix = "ARCANE-MACHINE-BINDING|1|";
#endif
            root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            AssertRegularDirectory(root, "release root");
            string marker = ReadOwnBindingMarker(expectedPrefix);
            string[] markerParts = marker.Split('|');
            if (markerParts.Length != 4 || markerParts[1] != "1" || !HashPattern.IsMatch(markerParts[3])) {
                throw new InvalidDataException("Arcane rejected its malformed native content binding.");
            }
            string version = InformationalVersion();
#if ARCANE_TARGET_APP
            if (!String.Equals(markerParts[2], Program.AppMode, StringComparison.Ordinal) || !AppIdPattern.IsMatch(markerParts[2])) {
                throw new InvalidDataException("Arcane target binding does not match the compiled application identity.");
            }
#else
            if (!String.Equals(markerParts[2], version, StringComparison.Ordinal)) {
                throw new InvalidDataException("Arcane machine binding does not match the compiled release version.");
            }
#endif
            string manifestPath = Path.Combine(root, manifestName);
            Dictionary<string, FileStream> retainedByPath = new Dictionary<string, FileStream>(StringComparer.OrdinalIgnoreCase);
            List<FileStream> retained = new List<FileStream>();
            Dictionary<string, RetainedDirectoryHandle> retainedDirectoriesByPath = new Dictionary<string, RetainedDirectoryHandle>(StringComparer.OrdinalIgnoreCase);
            List<RetainedDirectoryHandle> retainedDirectories = new List<RetainedDirectoryHandle>();
            try
            {
                RetainDirectoryTree(root, root, retainedDirectoriesByPath, retainedDirectories);
                FileStream retainedManifest = RetainFile(manifestPath, retainedByPath, retained);
                string manifestHash = HashStream(retainedManifest);
                if (!FixedTimeEquals(markerParts[3], manifestHash)) throw new InvalidDataException("Arcane rejected a content manifest that is not bound to this native host.");
                byte[] manifestBytes = ReadRetainedFile(retainedManifest, 64 * 1024 * 1024, manifestName);
                Dictionary<string, object> manifest = ParseObject(manifestBytes, manifestName);
#if ARCANE_TARGET_APP
                List<ManifestFile> files = VerifyTargetManifest(root, manifest, Program.AppMode, version);
                string wrapper = "ArcaneApp-" + Program.AppMode + ".exe";
                RequireCanonicalFile(root, wrapper);
                List<string> executables = ExecutableFiles(files, root);
                string wrapperPath = Path.Combine(root, wrapper);
                executables.Add(wrapperPath);
                List<string> excludedHosts = new List<string> { wrapperPath };
#else
                List<ManifestFile> files = VerifyMachineManifest(root, manifest, version);
                RequireCanonicalFile(root, "bin/ArcaneProvisioner.exe");
                RequireCanonicalFile(root, "bin/ArcaneShell.exe");
                string otherHost = Program.AppMode == "shell" ? "bin/ArcaneProvisioner.exe" : "bin/ArcaneShell.exe";
                string otherHostPath = Path.Combine(root, otherHost.Replace('/', Path.DirectorySeparatorChar));
                List<string> executables = ExecutableFiles(files, root);
                string provisionerPath = Path.Combine(root, "bin", "ArcaneProvisioner.exe");
                string shellPath = Path.Combine(root, "bin", "ArcaneShell.exe");
                executables.Add(provisionerPath);
                executables.Add(shellPath);
                List<string> excludedHosts = new List<string> { provisionerPath, shellPath };
#endif
                RetainAndRecheck(root, files, excludedHosts, retainedByPath, retained);
                VerifyRetainedDirectoryIdentities(retainedDirectories);
#if !ARCANE_TARGET_APP
                RequireEmbeddedMarker(retainedByPath[Path.GetFullPath(otherHostPath)], marker);
#endif
                bool allowUnsigned = HasExactArgument(args, "--allow-unsigned-local-release");
                string securityMode = VerifyExecutableSignatures(executables, allowUnsigned);
                return new ReleaseSecurityResult(root, securityMode, retained, retainedDirectories);
            }
            catch
            {
                foreach (FileStream file in retained) file.Dispose();
                foreach (RetainedDirectoryHandle directory in retainedDirectories) directory.Dispose();
                throw;
            }
        }

        private static void RetainDirectoryTree(
            string root,
            string directory,
            Dictionary<string, RetainedDirectoryHandle> opened,
            List<RetainedDirectoryHandle> retained)
        {
            RetainDirectory(directory, opened, retained);
            FileSystemInfo[] entries = new DirectoryInfo(directory).GetFileSystemInfos();
            Array.Sort(entries, delegate(FileSystemInfo left, FileSystemInfo right) { return StringComparer.Ordinal.Compare(left.Name, right.Name); });
            foreach (FileSystemInfo entry in entries)
            {
                if ((entry.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Arcane releases cannot contain reparse points: " + entry.FullName + ".");
                DirectoryInfo child = entry as DirectoryInfo;
                if (child == null) continue;
                string relative = RelativePath(root, child.FullName);
                ValidateRelativePath(relative);
                RetainDirectoryTree(root, child.FullName, opened, retained);
            }
        }

        private static RetainedDirectoryHandle RetainDirectory(
            string path,
            Dictionary<string, RetainedDirectoryHandle> opened,
            List<RetainedDirectoryHandle> retained)
        {
            string expected = NormalizeDirectoryPath(path);
            RetainedDirectoryHandle existing;
            if (opened.TryGetValue(expected, out existing)) return existing;
            SafeFileHandle handle = CreateFile(
                expected,
                FileReadAttributes | FileListDirectory,
                FileShareRead,
                IntPtr.Zero,
                OpenExisting,
                FileFlagBackupSemantics | FileFlagOpenReparsePoint,
                IntPtr.Zero);
            if (handle == null || handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                if (handle != null) handle.Dispose();
                throw new Win32Exception(error, "Arcane could not retain release directory " + expected + ".");
            }
            try
            {
                ByHandleFileInformation information = DirectoryInformation(handle, expected);
                FileAttributes attributes = (FileAttributes)information.FileAttributes;
                if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Arcane retained release path is not a regular directory: " + expected + ".");
                string finalPath = FinalPath(handle);
                if (!String.Equals(expected, finalPath, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Arcane directory handle does not resolve to its verified release path: " + expected + ".");
                ulong fileIndex = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
                RetainedDirectoryHandle result = new RetainedDirectoryHandle(handle, expected, information.VolumeSerialNumber, fileIndex);
                opened.Add(expected, result);
                retained.Add(result);
                return result;
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }

        private static void VerifyRetainedDirectoryIdentities(List<RetainedDirectoryHandle> retained)
        {
            foreach (RetainedDirectoryHandle directory in retained)
            {
                if (directory.Handle == null || directory.Handle.IsInvalid || directory.Handle.IsClosed)
                    throw new InvalidDataException("Arcane lost a retained release-directory handle before startup.");
                ByHandleFileInformation information = DirectoryInformation(directory.Handle, directory.ExpectedPath);
                FileAttributes attributes = (FileAttributes)information.FileAttributes;
                ulong fileIndex = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
                if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0
                    || information.VolumeSerialNumber != directory.VolumeSerialNumber || fileIndex != directory.FileIndex
                    || !String.Equals(FinalPath(directory.Handle), directory.ExpectedPath, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Arcane release directory identity changed during verification: " + directory.ExpectedPath + ".");
            }
        }

        private static ByHandleFileInformation DirectoryInformation(SafeFileHandle handle, string path)
        {
            ByHandleFileInformation information;
            if (!GetFileInformationByHandle(handle, out information))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Arcane could not inspect retained release directory " + path + ".");
            return information;
        }

        private static string FinalPath(SafeFileHandle handle)
        {
            StringBuilder buffer = new StringBuilder(1024);
            uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Arcane could not resolve a retained release-directory handle.");
            if (length >= buffer.Capacity)
            {
                if (length > 32767) throw new InvalidDataException("Arcane retained directory path exceeds the Windows maximum.");
                buffer = new StringBuilder((int)length + 1);
                length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
                if (length == 0 || length >= buffer.Capacity)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Arcane could not resolve a retained release-directory handle.");
            }
            return NormalizeDirectoryPath(StripDevicePathPrefix(buffer.ToString()));
        }

        private static string StripDevicePathPrefix(string value)
        {
            if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + value.Substring(8);
            if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) return value.Substring(4);
            return value;
        }

        private static string NormalizeDirectoryPath(string value)
        {
            string full = Path.GetFullPath(value);
            string pathRoot = Path.GetPathRoot(full);
            while (full.Length > pathRoot.Length && (full.EndsWith("\\", StringComparison.Ordinal) || full.EndsWith("/", StringComparison.Ordinal)))
                full = full.Substring(0, full.Length - 1);
            return full;
        }

        private static void RetainAndRecheck(
            string root,
            List<ManifestFile> files,
            List<string> excludedHosts,
            Dictionary<string, FileStream> opened,
            List<FileStream> retained)
        {
            foreach (ManifestFile entry in files)
            {
                string path = Path.Combine(root, entry.RelativePath.Replace('/', Path.DirectorySeparatorChar));
                FileStream file = RetainFile(path, opened, retained);
                if (file.Length != entry.Size || !FixedTimeEquals(HashStream(file), entry.Sha256))
                    throw new InvalidDataException("Arcane release file changed during verification: " + entry.RelativePath + ".");
            }
            foreach (string host in excludedHosts) RetainFile(host, opened, retained);
        }

        private static FileStream RetainFile(string path, Dictionary<string, FileStream> opened, List<FileStream> retained)
        {
            string fullPath = Path.GetFullPath(path);
            FileStream existing;
            if (opened.TryGetValue(fullPath, out existing)) return existing;
            AssertRegularFile(fullPath, "verified release file");
            FileStream stream = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.SequentialScan);
            try
            {
                FileAttributes attributes = File.GetAttributes(fullPath);
                if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) throw new InvalidDataException("Arcane retained release path is not a regular file: " + fullPath + ".");
                opened.Add(fullPath, stream);
                retained.Add(stream);
                return stream;
            }
            catch
            {
                stream.Dispose();
                throw;
            }
        }

        private static List<ManifestFile> VerifyMachineManifest(string root, Dictionary<string, object> manifest, string version)
        {
            RequireOnlyKeys(manifest, "machine manifest", "schemaVersion", "hashAlgorithm", "release", "files");
            RequireInteger(manifest, "schemaVersion", 1, "machine manifest");
            RequireString(manifest, "hashAlgorithm", "sha256", "machine manifest");
            Dictionary<string, object> release = RequireObject(manifest, "release", "machine manifest");
            RequireOnlyKeys(release, "machine release", "name", "version", "platform", "architecture");
            RequireNonEmptyString(release, "name", "machine release");
            RequireString(release, "version", version, "machine release");
            RequireString(release, "platform", "windows", "machine release");
            RequireString(release, "architecture", "x64", "machine release");
            HashSet<string> excluded = new HashSet<string>(StringComparer.Ordinal)
            {
                "arcane-install.json", MachineManifestName, "arcane-release.json",
                "bin/ArcaneProvisioner.exe", "bin/ArcaneShell.exe"
            };
            List<ManifestFile> files = VerifyInventory(root, manifest, excluded, "machine manifest");
            VerifyMachineContentLayout(files);
            RequireInventoryFile(files, "arcane-bundle.json");
            RequireInventoryFile(files, "bin/ArcaneCore.exe");
            RequireInventoryFile(files, "bin/ArcanePipeGuard.exe");
            RequireInventoryFile(files, "bin/Microsoft.Web.WebView2.Core.dll");
            RequireInventoryFile(files, "bin/Microsoft.Web.WebView2.WinForms.dll");
            RequireInventoryFile(files, "bin/WebView2Loader.dll");
            RequireInventoryFile(files, "app/" + Program.AppMode + "/index.html");
            RequireInventoryFile(files, "apps/catalog.json");
            return files;
        }

        private static List<ManifestFile> VerifyTargetManifest(string root, Dictionary<string, object> manifest, string appId, string version)
        {
            RequireOnlyKeys(manifest, "target manifest", "schemaVersion", "hashAlgorithm", "app", "files");
            RequireInteger(manifest, "schemaVersion", 1, "target manifest");
            RequireString(manifest, "hashAlgorithm", "sha256", "target manifest");
            Dictionary<string, object> app = RequireObject(manifest, "app", "target manifest");
            RequireOnlyKeys(app, "target application", "id", "version");
            RequireString(app, "id", appId, "target application");
            RequireString(app, "version", version, "target application");
            string wrapper = "ArcaneApp-" + appId + ".exe";
            HashSet<string> excluded = new HashSet<string>(StringComparer.Ordinal) { TargetManifestName, "arcane-app-package.json", wrapper };
            List<ManifestFile> files = VerifyInventory(root, manifest, excluded, "target manifest");
            VerifyTargetContentLayout(files);
            RequireInventoryFile(files, "ArcaneCore.exe");
            RequireInventoryFile(files, "ArcanePipeGuard.exe");
            RequireInventoryFile(files, "Microsoft.Web.WebView2.Core.dll");
            RequireInventoryFile(files, "Microsoft.Web.WebView2.WinForms.dll");
            RequireInventoryFile(files, "WebView2Loader.dll");
            RequireInventoryFile(files, "app/" + appId + "/index.html");
            return files;
        }

        private static void VerifyMachineContentLayout(List<ManifestFile> files)
        {
            HashSet<string> exactBinFiles = new HashSet<string>(StringComparer.Ordinal)
            {
                "bin/ArcaneCore.exe",
                "bin/ArcanePipeGuard.exe",
                "bin/Microsoft.Web.WebView2.Core.dll",
                "bin/Microsoft.Web.WebView2.WinForms.dll",
                "bin/WebView2Loader.dll"
            };
            foreach (ManifestFile file in files)
            {
                string relative = file.RelativePath;
                if (String.Equals(relative, "arcane-bundle.json", StringComparison.Ordinal)
                    || relative.StartsWith("app/", StringComparison.Ordinal)
                    || relative.StartsWith("apps/", StringComparison.Ordinal)
                    || exactBinFiles.Contains(relative)) continue;
                throw new InvalidDataException("Arcane machine content contains an unexpected release-layout path: " + relative + ".");
            }
        }

        private static void VerifyTargetContentLayout(List<ManifestFile> files)
        {
            HashSet<string> exactRootFiles = new HashSet<string>(StringComparer.Ordinal)
            {
                "arcane-bundle.json",
                "ArcaneCore.exe",
                "ArcanePipeGuard.exe",
                "Microsoft.Web.WebView2.Core.dll",
                "Microsoft.Web.WebView2.WinForms.dll",
                "WebView2Loader.dll"
            };
            foreach (ManifestFile file in files)
            {
                string relative = file.RelativePath;
                if (relative.StartsWith("app/", StringComparison.Ordinal) || exactRootFiles.Contains(relative)) continue;
                throw new InvalidDataException("Arcane target content contains an unexpected package-layout path: " + relative + ".");
            }
        }

        private static List<ManifestFile> VerifyInventory(string root, Dictionary<string, object> manifest, HashSet<string> excluded, string label)
        {
            object rawFiles;
            if (!manifest.TryGetValue("files", out rawFiles) || !(rawFiles is object[])) throw new InvalidDataException("Arcane " + label + " has no file inventory.");
            object[] values = (object[])rawFiles;
            if (values.Length == 0) throw new InvalidDataException("Arcane " + label + " has an empty file inventory.");
            List<ManifestFile> expected = new List<ManifestFile>();
            HashSet<string> paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string previous = null;
            for (int index = 0; index < values.Length; index++)
            {
                Dictionary<string, object> entry = values[index] as Dictionary<string, object>;
                if (entry == null) throw new InvalidDataException("Arcane " + label + " contains a non-object file entry.");
                RequireOnlyKeys(entry, label + " file", "path", "size", "sha256");
                string relative = RequireNonEmptyString(entry, "path", label + " file");
                ValidateRelativePath(relative);
                if (excluded.Contains(relative)) throw new InvalidDataException("Arcane " + label + " inventories an excluded path: " + relative + ".");
                if (!paths.Add(relative)) throw new InvalidDataException("Arcane " + label + " contains a duplicate or case-aliased path: " + relative + ".");
                if (previous != null && StringComparer.Ordinal.Compare(previous, relative) >= 0) throw new InvalidDataException("Arcane " + label + " file inventory is not strictly sorted.");
                previous = relative;
                long size = RequireNonNegativeInteger(entry, "size", label + " file");
                string hash = RequireNonEmptyString(entry, "sha256", label + " file");
                if (!HashPattern.IsMatch(hash)) throw new InvalidDataException("Arcane " + label + " contains an invalid SHA-256 value.");
                expected.Add(new ManifestFile(relative, size, hash));
            }

            List<ManifestFile> actual = EnumerateFiles(root, excluded);
            if (actual.Count != expected.Count) throw new InvalidDataException("Arcane " + label + " does not exactly match the release file inventory.");
            for (int index = 0; index < expected.Count; index++)
            {
                ManifestFile wanted = expected[index];
                ManifestFile found = actual[index];
                if (!String.Equals(wanted.RelativePath, found.RelativePath, StringComparison.Ordinal)
                    || wanted.Size != found.Size || !FixedTimeEquals(wanted.Sha256, found.Sha256))
                    throw new InvalidDataException("Arcane content verification failed for " + wanted.RelativePath + ".");
            }
            return expected;
        }

        private static List<ManifestFile> EnumerateFiles(string root, HashSet<string> excluded)
        {
            List<ManifestFile> files = new List<ManifestFile>();
            EnumerateDirectory(root, root, excluded, files);
            files.Sort(delegate(ManifestFile left, ManifestFile right) { return StringComparer.Ordinal.Compare(left.RelativePath, right.RelativePath); });
            return files;
        }

        private static void EnumerateDirectory(string root, string directory, HashSet<string> excluded, List<ManifestFile> files)
        {
            AssertRegularDirectory(directory, "release directory");
            FileSystemInfo[] entries = new DirectoryInfo(directory).GetFileSystemInfos();
            if (entries.Length == 0) throw new InvalidDataException("Arcane releases cannot contain empty directories: " + directory + ".");
            Array.Sort(entries, delegate(FileSystemInfo left, FileSystemInfo right) { return StringComparer.Ordinal.Compare(left.Name, right.Name); });
            foreach (FileSystemInfo entry in entries)
            {
                if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Arcane releases cannot contain reparse points: " + entry.FullName + ".");
                string relative = RelativePath(root, entry.FullName);
                ValidateRelativePath(relative);
                DirectoryInfo childDirectory = entry as DirectoryInfo;
                FileInfo file = entry as FileInfo;
                if (childDirectory != null) EnumerateDirectory(root, childDirectory.FullName, excluded, files);
                else if (file != null)
                {
                    if (excluded.Contains(relative)) continue;
                    files.Add(new ManifestFile(relative, file.Length, HashFile(file.FullName)));
                }
                else throw new InvalidDataException("Arcane releases can contain only regular files and directories.");
            }
        }

        private static string RelativePath(string root, string candidate)
        {
            string normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string normalizedCandidate = Path.GetFullPath(candidate);
            if (!normalizedCandidate.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Arcane release path escaped its verified root.");
            return normalizedCandidate.Substring(normalizedRoot.Length).Replace(Path.DirectorySeparatorChar, '/');
        }

        private static void ValidateRelativePath(string relative)
        {
            if (String.IsNullOrWhiteSpace(relative) || relative[0] == '/' || relative.IndexOf('\\') >= 0 || relative.IndexOf(':') >= 0 || relative.IndexOf('\0') >= 0)
                throw new InvalidDataException("Arcane rejected an unsafe release path.");
            string[] segments = relative.Split('/');
            foreach (string segment in segments)
            {
                if (String.IsNullOrEmpty(segment) || segment == "." || segment == ".." || segment.EndsWith(".", StringComparison.Ordinal)
                    || segment.EndsWith(" ", StringComparison.Ordinal) || ReservedNamePattern.IsMatch(segment))
                    throw new InvalidDataException("Arcane rejected an unsafe release path segment.");
                foreach (char value in segment) if (Char.IsControl(value)) throw new InvalidDataException("Arcane rejected a control character in a release path.");
            }
        }

        private static List<string> ExecutableFiles(List<ManifestFile> files, string root)
        {
            List<string> result = new List<string>();
            foreach (ManifestFile file in files)
            {
                if (!file.RelativePath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) continue;
                result.Add(Path.Combine(root, file.RelativePath.Replace('/', Path.DirectorySeparatorChar)));
            }
            return result;
        }

        private static string VerifyExecutableSignatures(List<string> executables, bool allowUnsigned)
        {
            if (executables == null || executables.Count == 0) throw new InvalidDataException("Arcane release contains no native executables to authenticate.");
            HashSet<string> unique = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string signer = null;
            bool sawValid = false;
            bool sawUnsigned = false;
            foreach (string executable in executables)
            {
                string fullPath = Path.GetFullPath(executable);
                if (!unique.Add(fullPath)) continue;
                AssertRegularFile(fullPath, "Arcane executable");
                SignatureEvidence evidence = Authenticode.Verify(fullPath);
                if (evidence.Status == SignatureStatus.Invalid) throw new InvalidDataException("Arcane rejected an invalid Authenticode signature on " + Path.GetFileName(fullPath) + ": " + evidence.Details);
                if (evidence.Status == SignatureStatus.NotSigned)
                {
                    sawUnsigned = true;
                    continue;
                }
                sawValid = true;
                if (String.IsNullOrWhiteSpace(evidence.SignerThumbprint)) throw new InvalidDataException("Arcane could not identify the trusted signer for " + Path.GetFileName(fullPath) + ".");
                if (signer == null) signer = evidence.SignerThumbprint;
                else if (!String.Equals(signer, evidence.SignerThumbprint, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Arcane rejected a release containing executables from different publishers.");
            }
            if (sawValid && sawUnsigned) throw new InvalidDataException("Arcane rejected a release that mixes signed and unsigned executables.");
            if (sawValid) return "publisher-verified";
            if (sawUnsigned && allowUnsigned) return "unsigned-local-test";
            throw new InvalidDataException("Arcane requires a publisher-signed release. The unsigned local override must be passed explicitly for controlled testing.");
        }

        private static string ReadOwnBindingMarker(string expectedPrefix)
        {
            string marker = null;
            object[] attributes = Assembly.GetExecutingAssembly().GetCustomAttributes(typeof(AssemblyMetadataAttribute), false);
            foreach (AssemblyMetadataAttribute attribute in attributes)
            {
                if (!String.Equals(attribute.Key, BindingMetadataKey, StringComparison.Ordinal)) continue;
                if (marker != null) throw new InvalidDataException("Arcane native host contains duplicate content bindings.");
                marker = attribute.Value;
            }
            if (String.IsNullOrWhiteSpace(marker) || !marker.StartsWith(expectedPrefix, StringComparison.Ordinal)) throw new InvalidDataException("Arcane native host is missing its release content binding.");
            return marker;
        }

        private static string InformationalVersion()
        {
            object[] attributes = Assembly.GetExecutingAssembly().GetCustomAttributes(typeof(AssemblyInformationalVersionAttribute), false);
            if (attributes.Length != 1) throw new InvalidDataException("Arcane native host has no unique informational version.");
            string value = ((AssemblyInformationalVersionAttribute)attributes[0]).InformationalVersion;
            if (String.IsNullOrWhiteSpace(value)) throw new InvalidDataException("Arcane native host has an empty informational version.");
            return value;
        }

        private static void RequireEmbeddedMarker(FileStream file, string marker)
        {
            if (file == null) throw new InvalidDataException("Arcane could not retain its peer native host.");
            byte[] data = ReadRetainedFile(file, 64 * 1024 * 1024, "peer native host");
            byte[] ascii = Encoding.ASCII.GetBytes(marker);
            byte[] unicode = Encoding.Unicode.GetBytes(marker);
            int count = CountOccurrences(data, ascii) + CountOccurrences(data, unicode);
            if (count != 1) throw new InvalidDataException("Arcane peer host must contain exactly one matching release content binding.");
        }

        private static byte[] ReadRetainedFile(FileStream file, int maximumLength, string label)
        {
            if (file.Length < 1 || file.Length > maximumLength) throw new InvalidDataException("Arcane " + label + " has an invalid size.");
            file.Position = 0;
            byte[] data = new byte[(int)file.Length];
            int offset = 0;
            while (offset < data.Length)
            {
                int count = file.Read(data, offset, data.Length - offset);
                if (count == 0) throw new EndOfStreamException("Arcane " + label + " changed while it was retained.");
                offset += count;
            }
            file.Position = 0;
            return data;
        }

        private static int CountOccurrences(byte[] data, byte[] pattern)
        {
            if (pattern.Length == 0 || data.Length < pattern.Length) return 0;
            int count = 0;
            for (int offset = 0; offset <= data.Length - pattern.Length;)
            {
                int index = 0;
                while (index < pattern.Length && data[offset + index] == pattern[index]) index++;
                if (index == pattern.Length)
                {
                    count++;
                    offset += pattern.Length;
                }
                else offset++;
            }
            return count;
        }

        private static bool HasExactArgument(string[] args, string expected)
        {
            int matches = 0;
            foreach (string argument in args ?? new string[0]) if (String.Equals(argument, expected, StringComparison.Ordinal)) matches++;
            if (matches > 1) throw new ArgumentException("Arcane rejected a duplicated release-security argument.");
            return matches == 1;
        }

        private static Dictionary<string, object> ParseObject(byte[] bytes, string label)
        {
            string text = new UTF8Encoding(false, true).GetString(bytes);
            JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024, RecursionLimit = 256 };
            Dictionary<string, object> result;
            try { result = serializer.DeserializeObject(text) as Dictionary<string, object>; }
            catch (Exception error) { throw new InvalidDataException("Arcane " + label + " is not valid JSON.", error); }
            if (result == null) throw new InvalidDataException("Arcane " + label + " must contain a JSON object.");
            return result;
        }

        private static void RequireOnlyKeys(Dictionary<string, object> value, string label, params string[] allowed)
        {
            HashSet<string> keys = new HashSet<string>(allowed, StringComparer.Ordinal);
            foreach (string key in value.Keys) if (!keys.Contains(key)) throw new InvalidDataException("Arcane " + label + " contains unknown field " + key + ".");
            foreach (string key in allowed) if (!value.ContainsKey(key)) throw new InvalidDataException("Arcane " + label + " is missing field " + key + ".");
        }

        private static Dictionary<string, object> RequireObject(Dictionary<string, object> value, string key, string label)
        {
            object result;
            if (!value.TryGetValue(key, out result) || !(result is Dictionary<string, object>)) throw new InvalidDataException("Arcane " + label + " field " + key + " must be an object.");
            return (Dictionary<string, object>)result;
        }

        private static string RequireNonEmptyString(Dictionary<string, object> value, string key, string label)
        {
            object result;
            string text;
            if (!value.TryGetValue(key, out result) || (text = result as string) == null || String.IsNullOrWhiteSpace(text)) throw new InvalidDataException("Arcane " + label + " field " + key + " must be a non-empty string.");
            return text;
        }

        private static void RequireString(Dictionary<string, object> value, string key, string expected, string label)
        {
            string actual = RequireNonEmptyString(value, key, label);
            if (!String.Equals(actual, expected, StringComparison.Ordinal)) throw new InvalidDataException("Arcane " + label + " field " + key + " does not match this release.");
        }

        private static void RequireInteger(Dictionary<string, object> value, string key, long expected, string label)
        {
            if (RequireNonNegativeInteger(value, key, label) != expected) throw new InvalidDataException("Arcane " + label + " field " + key + " is unsupported.");
        }

        private static long RequireNonNegativeInteger(Dictionary<string, object> value, string key, string label)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || raw == null) throw new InvalidDataException("Arcane " + label + " field " + key + " must be an integer.");
            long result;
            if (raw is int) result = (int)raw;
            else if (raw is long) result = (long)raw;
            else throw new InvalidDataException("Arcane " + label + " field " + key + " must be an integer.");
            if (result < 0) throw new InvalidDataException("Arcane " + label + " field " + key + " cannot be negative.");
            return result;
        }

        private static void RequireInventoryFile(List<ManifestFile> files, string relative)
        {
            foreach (ManifestFile file in files) if (String.Equals(file.RelativePath, relative, StringComparison.Ordinal)) return;
            throw new InvalidDataException("Arcane content manifest does not verify required file " + relative + ".");
        }

        private static void RequireCanonicalFile(string root, string relative)
        {
            string[] segments = relative.Split('/');
            string current = root;
            foreach (string segment in segments)
            {
                current = Path.Combine(current, segment);
                FileSystemInfo info = Directory.Exists(current) ? (FileSystemInfo)new DirectoryInfo(current) : new FileInfo(current);
                if (!info.Exists || !String.Equals(info.Name, segment, StringComparison.Ordinal)) throw new FileNotFoundException("Arcane release is missing canonical file " + relative + ".", current);
                if ((info.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Arcane releases cannot contain reparse points: " + relative + ".");
            }
            AssertRegularFile(current, relative);
        }

        private static void AssertRegularDirectory(string path, string label)
        {
            DirectoryInfo info = new DirectoryInfo(path);
            if (!info.Exists || (info.Attributes & FileAttributes.Directory) == 0 || (info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Arcane " + label + " must be a regular directory.");
        }

        private static void AssertRegularFile(string path, string label)
        {
            FileInfo info = new FileInfo(path);
            if (!info.Exists || (info.Attributes & FileAttributes.Directory) != 0 || (info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Arcane " + label + " must be a regular file.");
        }

        private static string HashFile(string path)
        {
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (SHA256 hash = SHA256.Create())
            {
                byte[] bytes = hash.ComputeHash(stream);
                StringBuilder text = new StringBuilder(bytes.Length * 2);
                foreach (byte value in bytes) text.Append(value.ToString("x2", CultureInfo.InvariantCulture));
                return text.ToString();
            }
        }

        private static string HashStream(FileStream stream)
        {
            stream.Position = 0;
            using (SHA256 hash = SHA256.Create())
            {
                byte[] bytes = hash.ComputeHash(stream);
                stream.Position = 0;
                StringBuilder text = new StringBuilder(bytes.Length * 2);
                foreach (byte value in bytes) text.Append(value.ToString("x2", CultureInfo.InvariantCulture));
                return text.ToString();
            }
        }

        private static bool FixedTimeEquals(string left, string right)
        {
            if (left == null || right == null || left.Length != right.Length) return false;
            int different = 0;
            for (int index = 0; index < left.Length; index++) different |= left[index] ^ right[index];
            return different == 0;
        }

        private sealed class ManifestFile
        {
            internal string RelativePath { get; private set; }
            internal long Size { get; private set; }
            internal string Sha256 { get; private set; }
            internal ManifestFile(string relativePath, long size, string sha256) { RelativePath = relativePath; Size = size; Sha256 = sha256; }
        }
    }

    internal enum SignatureStatus { Valid, NotSigned, Invalid }

    internal sealed class SignatureEvidence
    {
        internal SignatureStatus Status { get; private set; }
        internal string SignerThumbprint { get; private set; }
        internal string Details { get; private set; }
        internal SignatureEvidence(SignatureStatus status, string signerThumbprint, string details) { Status = status; SignerThumbprint = signerThumbprint; Details = details; }
    }

    internal static class Authenticode
    {
        private static readonly Guid GenericVerifyV2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        private const int TrustENoSignature = unchecked((int)0x800B0100);
        private const int TrustESubjectFormUnknown = unchecked((int)0x800B0003);
        private const int TrustEProviderUnknown = unchecked((int)0x800B0001);

        [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = true, PreserveSig = true)]
        private static extern int WinVerifyTrust(IntPtr window, ref Guid action, [In] WinTrustData data);

        internal static SignatureEvidence Verify(string file)
        {
            using (WinTrustFileInfo fileInfo = new WinTrustFileInfo(file))
            using (WinTrustData trustData = new WinTrustData(fileInfo))
            {
                Guid action = GenericVerifyV2;
                int result = WinVerifyTrust(new IntPtr(-1), ref action, trustData);
                if (result == 0)
                {
                    try
                    {
                        using (X509Certificate2 certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(file)))
                        {
                            return new SignatureEvidence(SignatureStatus.Valid, certificate.Thumbprint, "WinVerifyTrust validated the Authenticode publisher.");
                        }
                    }
                    catch (Exception error) { return new SignatureEvidence(SignatureStatus.Invalid, null, "WinVerifyTrust did not yield a signer certificate: " + error.Message); }
                }
                if (result == TrustENoSignature || result == TrustESubjectFormUnknown || result == TrustEProviderUnknown)
                    return new SignatureEvidence(SignatureStatus.NotSigned, null, "The file has no Authenticode signature.");
                return new SignatureEvidence(SignatureStatus.Invalid, null, "WinVerifyTrust returned 0x" + result.ToString("X8", CultureInfo.InvariantCulture) + ".");
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private sealed class WinTrustFileInfo : IDisposable
        {
            private uint structureSize = (uint)Marshal.SizeOf(typeof(WinTrustFileInfo));
            private IntPtr filePath;
            private IntPtr fileHandle = IntPtr.Zero;
            private IntPtr knownSubject = IntPtr.Zero;
            internal WinTrustFileInfo(string file) { filePath = Marshal.StringToCoTaskMemUni(file); }
            public void Dispose() { if (filePath != IntPtr.Zero) { Marshal.FreeCoTaskMem(filePath); filePath = IntPtr.Zero; } }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private sealed class WinTrustData : IDisposable
        {
            private uint structureSize = (uint)Marshal.SizeOf(typeof(WinTrustData));
            private IntPtr policyCallbackData = IntPtr.Zero;
            private IntPtr sipClientData = IntPtr.Zero;
            private uint uiChoice = 2;
            private uint revocationChecks = 0;
            private uint unionChoice = 1;
            private IntPtr fileInfo;
            private uint stateAction = 0;
            private IntPtr stateData = IntPtr.Zero;
            private IntPtr urlReference = IntPtr.Zero;
            private uint providerFlags = 0;
            private uint uiContext = 0;
            internal WinTrustData(WinTrustFileInfo info)
            {
                fileInfo = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WinTrustFileInfo)));
                Marshal.StructureToPtr(info, fileInfo, false);
            }
            public void Dispose()
            {
                if (fileInfo != IntPtr.Zero) { Marshal.DestroyStructure(fileInfo, typeof(WinTrustFileInfo)); Marshal.FreeCoTaskMem(fileInfo); fileInfo = IntPtr.Zero; }
            }
        }
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.AutoDual)]
    public sealed class ArcaneBridge
    {
        private readonly ArcaneCoreProcess core;
        internal ArcaneBridge(ArcaneCoreProcess coreProcess) { core = coreProcess; }

        public string Send(string requestJson)
        {
            try
            {
                core.Send(requestJson);
                return "{\"accepted\":true}";
            }
            catch (Exception error)
            {
                return "{\"accepted\":false,\"error\":{\"code\":\"NATIVE_BRIDGE_WRITE_FAILED\",\"message\":" + JsonString(error.Message) + "}}";
            }
        }

        private static string JsonString(string value)
        {
            return "\"" + (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\"";
        }
    }

    internal sealed class ArcaneForm : Form
    {
        private readonly string[] launchArgs;
        private readonly ReleaseSecurityResult releaseSecurity;
        private readonly WebView2 webView;
        private ArcaneCoreProcess core;
        private readonly ConcurrentQueue<string> pendingMessages = new ConcurrentQueue<string>();
        private bool webReady;

        public ArcaneForm(string[] args, ReleaseSecurityResult verifiedRelease)
        {
            launchArgs = args ?? new string[0];
            if (verifiedRelease == null) throw new ArgumentNullException("verifiedRelease");
            releaseSecurity = verifiedRelease;
            Text = Program.ProductName;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(900, 650);
            Size = Program.AppMode == "shell" ? Screen.PrimaryScreen.Bounds.Size : new Size(1240, 860);
            if (Program.AppMode == "shell")
            {
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Maximized;
                TopMost = false;
            }
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            webView = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(webView);
            Shown += async delegate { await InitializeAsync(); };
            FormClosing += OnFormClosing;
        }

        private async Task InitializeAsync()
        {
            try
            {
                string bundleRoot = releaseSecurity.ReleaseRoot;
#if ARCANE_TARGET_APP
                string webRoot = Path.Combine(bundleRoot, "app");
                string navigationPath = "/" + Program.AppMode + "/index.html";
                string appIndex = Path.Combine(webRoot, Program.AppMode, "index.html");
#else
                string webRoot = bundleRoot;
                string navigationPath = "/app/" + Program.AppMode + "/index.html";
                string appIndex = Path.Combine(webRoot, "app", Program.AppMode, "index.html");
#endif
                if (!File.Exists(appIndex)) throw new FileNotFoundException("Arcane application assets are missing.", appIndex);

                core = ArcaneCoreProcess.Start(bundleRoot, Program.AppMode, launchArgs, releaseSecurity);
                core.MessageReceived += DeliverCoreMessage;
                core.Failed += delegate(string message) { BeginInvoke(new Action(delegate { ShowFatal("Arcane Core stopped", message); })); };

                await EnsureWebViewRuntimeAsync();
                string userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Arcane OS", "WebView2", Program.AppMode);
                Directory.CreateDirectory(userData);
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userData);
                await webView.EnsureCoreWebView2Async(environment);

                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = HasArg("--devtools");
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
                webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = Program.AppMode != "shell";
                webView.CoreWebView2.SetVirtualHostNameToFolderMapping("arcane.local", webRoot, CoreWebView2HostResourceAccessKind.DenyCors);
                webView.CoreWebView2.AddHostObjectToScript("arcaneBridge", new ArcaneBridge(core));
                webView.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs eventArgs)
                {
                    if (!IsAllowedAppUri(eventArgs.Uri)) eventArgs.Cancel = true;
                };
                webView.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs eventArgs) { eventArgs.Handled = true; };
                webView.CoreWebView2.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs eventArgs)
                {
                    bool allowMicrophone = Program.AllowMicrophone
                        && eventArgs.PermissionKind == CoreWebView2PermissionKind.Microphone
                        && IsTrustedAppOrigin(eventArgs.Uri);
                    eventArgs.State = allowMicrophone ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
                    eventArgs.SavesInProfile = false;
                };
                webView.CoreWebView2.ProcessFailed += delegate(object sender, CoreWebView2ProcessFailedEventArgs eventArgs)
                {
                    BeginInvoke(new Action(delegate { ShowFatal("Arcane renderer stopped", eventArgs.ProcessFailedKind.ToString()); }));
                };
                webView.CoreWebView2.NavigationCompleted += delegate
                {
                    webReady = true;
                    string message;
                    while (pendingMessages.TryDequeue(out message)) PostMessage(message);
                };
                webView.Source = new Uri("https://arcane.local" + navigationPath);
            }
            catch (Exception error)
            {
                ShowFatal("Arcane could not start", error.ToString());
            }
        }

        private bool HasArg(string name)
        {
            foreach (string value in launchArgs) if (String.Equals(value, name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private static bool IsAllowedAppUri(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri)) return false;
            if (!IsTrustedAppOrigin(uri)) return false;
            if (!String.IsNullOrEmpty(uri.Query) || !String.IsNullOrEmpty(uri.Fragment)) return false;
#if ARCANE_TARGET_APP
            foreach (string allowedPath in Program.AllowedNavigationPaths)
                if (String.Equals(uri.AbsolutePath, allowedPath, StringComparison.Ordinal)) return true;
            return false;
#else
            return String.Equals(uri.AbsolutePath, "/app/" + Program.AppMode + "/index.html", StringComparison.Ordinal);
#endif
        }

        private static bool IsTrustedAppOrigin(string value)
        {
            Uri uri;
            return Uri.TryCreate(value, UriKind.Absolute, out uri) && IsTrustedAppOrigin(uri);
        }

        private static bool IsTrustedAppOrigin(Uri uri)
        {
            return String.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
                && String.Equals(uri.Host, "arcane.local", StringComparison.OrdinalIgnoreCase)
                && uri.IsDefaultPort
                && String.IsNullOrEmpty(uri.UserInfo);
        }

        private Task EnsureWebViewRuntimeAsync()
        {
            try
            {
                string version = CoreWebView2Environment.GetAvailableBrowserVersionString();
                if (!String.IsNullOrWhiteSpace(version)) return Task.CompletedTask;
            }
            catch { }
            throw new InvalidOperationException("Microsoft Edge WebView2 Runtime is required. Install the Evergreen Runtime from Microsoft, then reopen Arcane. Arcane will not download and elevate an unverified bootstrapper from the renderer host.");
        }

        private void DeliverCoreMessage(string json)
        {
            if (IsDisposed) return;
            BeginInvoke(new Action(delegate
            {
                if (!webReady || webView.CoreWebView2 == null) pendingMessages.Enqueue(json);
                else PostMessage(json);
            }));
        }

        private void PostMessage(string json)
        {
            try { webView.CoreWebView2.PostWebMessageAsJson(json); }
            catch { pendingMessages.Enqueue(json); }
        }

        private void OnFormClosing(object sender, FormClosingEventArgs eventArgs)
        {
            if (core != null) core.Dispose();
            if (Program.AppMode != "shell") return;
            if (eventArgs.CloseReason == CloseReason.WindowsShutDown) ShellWatchdog.Disarm();
            else EmergencyDesktop.TryStart();
        }

        private void ShowFatal(string title, string details)
        {
            try
            {
                if (Program.AppMode == "shell") EmergencyDesktop.TryStart();
                MessageBox.Show(this, details, title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally { Close(); }
        }
    }

    internal sealed class ArcaneCoreProcess : IDisposable
    {
        private readonly Process process;
        private readonly Stream input;
        private readonly SemaphoreSlim writeLock = new SemaphoreSlim(1, 1);
        private bool disposed;

        public event Action<string> MessageReceived;
        public event Action<string> Failed;

        private ArcaneCoreProcess(Process child)
        {
            process = child;
            input = child.StandardInput.BaseStream;
            Task.Run((Func<Task>)ReadLoopAsync);
            Task.Run((Func<Task>)ReadErrorsAsync);
            child.EnableRaisingEvents = true;
            child.Exited += delegate
            {
                if (!disposed && Failed != null) Failed("Arcane Core exited with code " + child.ExitCode + ". See the Arcane log for details.");
            };
        }

        public static ArcaneCoreProcess Start(string bundleRoot, string appMode, string[] hostArgs, ReleaseSecurityResult releaseSecurity)
        {
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            string packaged = Path.Combine(directory, "ArcaneCore.exe");
            if (!File.Exists(packaged)) throw new FileNotFoundException("ArcaneCore.exe is missing from this release.", packaged);
            string fileName = packaged;
            string arguments = BuildArguments(bundleRoot, appMode, hostArgs, releaseSecurity);

            ProcessStartInfo start = new ProcessStartInfo(fileName, arguments)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = directory
            };
            string systemRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            string system32 = Path.Combine(systemRoot, "System32");
            string powerShell = Path.Combine(system32, "WindowsPowerShell", "v1.0");
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            start.EnvironmentVariables.Clear();
            start.EnvironmentVariables["SystemRoot"] = systemRoot;
            start.EnvironmentVariables["windir"] = systemRoot;
            start.EnvironmentVariables["ProgramFiles"] = programFiles;
            start.EnvironmentVariables["ProgramFiles(x86)"] = programFilesX86;
            start.EnvironmentVariables["PROGRAMFILES(X86)"] = programFilesX86;
            start.EnvironmentVariables["ProgramData"] = programData;
            start.EnvironmentVariables["LOCALAPPDATA"] = localAppData;
            start.EnvironmentVariables["USERPROFILE"] = userProfile;
            start.EnvironmentVariables["USERNAME"] = Environment.UserName;
            start.EnvironmentVariables["USERDOMAIN"] = Environment.UserDomainName;
            start.EnvironmentVariables["COMPUTERNAME"] = Environment.MachineName;
            start.EnvironmentVariables["PATH"] = String.Join(";", new string[] { system32, systemRoot, powerShell });
            start.EnvironmentVariables["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
            start.EnvironmentVariables["ComSpec"] = Path.Combine(system32, "cmd.exe");
            start.EnvironmentVariables["PSModulePath"] = Path.Combine(powerShell, "Modules");
            start.EnvironmentVariables["ARCANE_RELEASE_SECURITY_MODE"] = releaseSecurity.SecurityMode;
            Process child = Process.Start(start);
            if (child == null) throw new InvalidOperationException("Windows did not start Arcane Core.");
            return new ArcaneCoreProcess(child);
        }

        private static string BuildArguments(string bundleRoot, string appMode, string[] hostArgs, ReleaseSecurityResult releaseSecurity)
        {
            StringBuilder result = new StringBuilder();
            result.Append("--app=").Append(Quote(appMode)).Append(" --bundle-root=").Append(Quote(bundleRoot));
            foreach (string arg in hostArgs ?? new string[0])
            {
                if (arg == "--simulate"
                    || arg.StartsWith("--simulate-platform=", StringComparison.OrdinalIgnoreCase))
                    result.Append(' ').Append(Quote(arg));
            }
            if (releaseSecurity.IsUnsignedLocalTest) result.Append(" --allow-unsigned-local-release");
            return result.ToString();
        }

        private static string Quote(string value)
        {
            return "\"" + (value ?? "").Replace("\"", "\\\"") + "\"";
        }

        public void Send(string json)
        {
            if (disposed || process.HasExited) throw new InvalidOperationException("Arcane Core is not running.");
            byte[] body = Encoding.UTF8.GetBytes(json);
            byte[] header = Encoding.ASCII.GetBytes("Content-Length: " + body.Length + "\r\n\r\n");
            writeLock.Wait();
            try
            {
                input.Write(header, 0, header.Length);
                input.Write(body, 0, body.Length);
                input.Flush();
            }
            finally { writeLock.Release(); }
        }

        private async Task ReadLoopAsync()
        {
            Stream output = process.StandardOutput.BaseStream;
            try
            {
                while (!disposed)
                {
                    string json = await ReadFrameAsync(output);
                    if (json == null) break;
                    Action<string> handler = MessageReceived;
                    if (handler != null) handler(json);
                }
            }
            catch (Exception error)
            {
                if (!disposed && Failed != null) Failed("Arcane IPC failed: " + error.Message);
            }
        }

        private async Task ReadErrorsAsync()
        {
            try
            {
                string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Arcane OS", "logs");
                Directory.CreateDirectory(folder);
                string log = Path.Combine(folder, Program.AppMode + "-core.log");
                while (!disposed)
                {
                    string line = await process.StandardError.ReadLineAsync();
                    if (line == null) break;
                    File.AppendAllText(log, DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine);
                }
            }
            catch { }
        }

        private static async Task<string> ReadFrameAsync(Stream stream)
        {
            MemoryStream header = new MemoryStream();
            int matched = 0;
            byte[] marker = new byte[] { 13, 10, 13, 10 };
            while (true)
            {
                int value = await ReadByteAsync(stream);
                if (value < 0) return null;
                header.WriteByte((byte)value);
                if ((byte)value == marker[matched]) matched++; else matched = (byte)value == marker[0] ? 1 : 0;
                if (matched == marker.Length) break;
                if (header.Length > 65536) throw new InvalidDataException("Arcane IPC header exceeded the allowed size.");
            }
            string text = Encoding.ASCII.GetString(header.ToArray());
            Match match = Regex.Match(text, @"Content-Length:\s*(\d+)", RegexOptions.IgnoreCase);
            if (!match.Success) throw new InvalidDataException("Arcane IPC frame did not contain Content-Length.");
            int length = Int32.Parse(match.Groups[1].Value);
            if (length < 0 || length > 16 * 1024 * 1024) throw new InvalidDataException("Arcane IPC frame exceeded the allowed size.");
            byte[] body = new byte[length];
            int offset = 0;
            while (offset < length)
            {
                int count = await stream.ReadAsync(body, offset, length - offset);
                if (count == 0) throw new EndOfStreamException("Arcane Core closed the IPC stream during a message.");
                offset += count;
            }
            return Encoding.UTF8.GetString(body);
        }

        private static async Task<int> ReadByteAsync(Stream stream)
        {
            byte[] one = new byte[1];
            int count = await stream.ReadAsync(one, 0, 1);
            return count == 0 ? -1 : one[0];
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            try { input.Close(); } catch { }
            try { if (!process.HasExited) process.Kill(); } catch { }
            try { process.Dispose(); } catch { }
            writeLock.Dispose();
        }
    }
}
