param(
  [string]$Dist = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\windows'),
  [string[]]$Files = @('ArcaneProvisioner.exe', 'ArcaneShell.exe')
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ArcaneDispatchProbe
{
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetIDsOfNames(
        IntPtr self,
        ref Guid interfaceId,
        IntPtr names,
        uint nameCount,
        uint localeId,
        IntPtr dispatchIds
    );

    public static int GetDispatchId(object instance, string name)
    {
        IntPtr dispatch = IntPtr.Zero;
        IntPtr nameText = IntPtr.Zero;
        IntPtr names = IntPtr.Zero;
        IntPtr dispatchIds = IntPtr.Zero;

        try
        {
            dispatch = Marshal.GetIDispatchForObject(instance);
            IntPtr vtable = Marshal.ReadIntPtr(dispatch);
            IntPtr function = Marshal.ReadIntPtr(vtable, 5 * IntPtr.Size);
            GetIDsOfNames lookup = (GetIDsOfNames)Marshal.GetDelegateForFunctionPointer(
                function,
                typeof(GetIDsOfNames)
            );

            nameText = Marshal.StringToCoTaskMemUni(name);
            names = Marshal.AllocCoTaskMem(IntPtr.Size);
            Marshal.WriteIntPtr(names, nameText);
            dispatchIds = Marshal.AllocCoTaskMem(sizeof(int));
            Marshal.WriteInt32(dispatchIds, -1);

            Guid empty = Guid.Empty;
            int result = lookup(dispatch, ref empty, names, 1, 0, dispatchIds);
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            return Marshal.ReadInt32(dispatchIds);
        }
        finally
        {
            if (dispatchIds != IntPtr.Zero) Marshal.FreeCoTaskMem(dispatchIds);
            if (names != IntPtr.Zero) Marshal.FreeCoTaskMem(names);
            if (nameText != IntPtr.Zero) Marshal.FreeCoTaskMem(nameText);
            if (dispatch != IntPtr.Zero) Marshal.Release(dispatch);
        }
    }
}
'@

$bindingFlags = [Reflection.BindingFlags]'Instance,NonPublic'
foreach ($fileName in $Files) {
  $path = Join-Path $Dist $fileName
  if (-not (Test-Path -LiteralPath $path)) {
    throw "$fileName is missing. Build the Windows hosts before checking their COM dispatch surface."
  }

  $assembly = [Reflection.Assembly]::LoadFrom((Resolve-Path -LiteralPath $path))
  $bridgeType = $assembly.GetType('ArcaneOS.ArcaneBridge', $true)
  $constructor = $bridgeType.GetConstructors($bindingFlags) |
    Where-Object { $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  if (-not $constructor) {
    throw "$fileName does not contain the expected internal ArcaneBridge constructor."
  }

  $bridge = $constructor.Invoke([object[]]@($null))
  $dispatchId = [ArcaneDispatchProbe]::GetDispatchId($bridge, 'Send')
  if ($dispatchId -lt 0) {
    throw "$fileName exposed Send with an invalid COM dispatch identifier."
  }
  Write-Host "$fileName exposes ArcaneBridge.Send through IDispatch (DISPID $dispatchId)."
}

Write-Host 'Windows WebView2 bridge COM dispatch verification passed.'
