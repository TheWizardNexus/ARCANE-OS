import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sourcePath = path.join(root, 'src/hosts/windows/ArcaneHost.cs');
const source = await fs.readFile(sourcePath, 'utf8');
const frontendPath = path.join(root, 'src/frontend/shared/arcane-api.js');
const frontend = await fs.readFile(frontendPath, 'utf8');

if (!source.includes('public sealed class ArcaneBridge')) {
  throw new Error('ArcaneBridge must remain public so WebView2 can project it into JavaScript.');
}
if (!source.includes('internal ArcaneBridge(ArcaneCoreProcess coreProcess)')) {
  throw new Error('ArcaneBridge constructor must be internal because ArcaneCoreProcess is an internal host implementation type.');
}
if (source.includes('public ArcaneBridge(ArcaneCoreProcess coreProcess)')) {
  throw new Error('Windows host would fail with CS0051: public ArcaneBridge constructor exposes internal ArcaneCoreProcess.');
}
if (!source.includes('internal sealed class ArcaneCoreProcess')) {
  throw new Error('ArcaneCoreProcess should remain internal to the native Windows host.');
}
if (!source.includes('public string Send(string requestJson)')) {
  throw new Error('ArcaneBridge must expose Send so WebView2 can resolve it through COM IDispatch.');
}
if (source.includes('public string Invoke(string requestJson)')) {
  throw new Error('ArcaneBridge.Invoke conflicts with COM IDispatch.Invoke and is not script-callable. Use Send.');
}
if (!frontend.includes('this.bridge.Send(JSON.stringify(request))')) {
  throw new Error('The WebView2 frontend transport must call ArcaneBridge.Send.');
}
if (frontend.includes('this.bridge.Invoke(JSON.stringify(request))')) {
  throw new Error('The WebView2 frontend still calls the COM-reserved Invoke name.');
}
if (source.includes('DownloadFileTaskAsync') || source.includes('Verb = "runas"')) {
  throw new Error('The renderer host must not download and elevate an installer before its native trust policy is available.');
}
if (!source.includes('Environment.GetFolderPath(Environment.SpecialFolder.Windows)') || !source.includes('Path.Combine(windows, "explorer.exe")')) {
  throw new Error('The shell emergency desktop must resolve Explorer from the trusted absolute Windows directory.');
}
if (!source.includes('if (Program.AppMode == "shell") EmergencyDesktop.TryStart();')) {
  throw new Error('Shell fatal startup paths must activate the emergency Windows desktop.');
}
for (const trustContract of [
  '[In, Out] WinTrustData data',
  'AuthenticodePurpose.StrictOnline',
  'AuthenticodePurpose.OfflineBaseline',
  'AuthenticodePurpose.OfflineRevocation',
  'private uint stateAction = 1;',
  'internal void PrepareToClose() { stateAction = 2; }',
  'WTHelperProvDataFromStateData',
  'WTHelperGetProvSignerFromChain',
  'SignatureStatus.Revoked',
  'SignatureStatus.RevocationUnavailable',
  'SignatureStatus.TimedOut',
  'ValidatePublisherAttestation(releaseRoot, contentBinding, signer, retainedByPath, retained)',
  'AssertAdminProtected(File.GetAccessControl(manifestPath',
  'RegistryView.Registry64',
  'AssertAdminControlledRegistry(key.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access)',
  'StartOnlineSecurityRefresh();',
  'ReleaseSecurityVerifier.RefreshOnline(releaseSecurity)',
  'releaseSecurity.RemainingDegradedLifetime(DateTimeOffset.UtcNow)',
  'CapDegradedRetryDelay(',
]) {
  if (!source.includes(trustContract)) throw new Error(`Windows publisher trust contract is missing: ${trustContract}`);
}
const authenticodeProbeDispatch = source.indexOf('if (AuthenticodeProbe.TryRun(args)) return;');
const publisherProbeDispatch = source.indexOf('if (PublisherAttestationProbe.TryRun(args)) return;');
if (authenticodeProbeDispatch < 0 || authenticodeProbeDispatch > publisherProbeDispatch || authenticodeProbeDispatch > source.indexOf('instanceMutex = new Mutex')) {
  throw new Error('The killable Authenticode worker dispatch must run before all normal host initialization.');
}
const authenticodeStart = source.indexOf('internal static class AuthenticodeProbe');
const authenticodeEnd = source.indexOf('internal sealed class BoundedProcessResult', authenticodeStart);
const authenticodeSource = source.slice(authenticodeStart, authenticodeEnd);
for (const workerContract of [
  'new ProcessStartInfo(workerPath)',
  'RedirectStandardOutput = true',
  'RedirectStandardError = true',
  'start.EnvironmentVariables.Clear();',
  'TaskCreationOptions.LongRunning',
  'ReadBounded(child.StandardOutput, MaximumProbeOutput)',
  'Stopwatch clock = Stopwatch.StartNew();',
  'child.Kill();',
  'child.WaitForExit(5000)',
  'SignatureStatus.TimedOut',
  'Authenticode.VerifyCore(fullPath, purpose)',
]) {
  if (!authenticodeSource.includes(workerContract)) throw new Error(`Killable Authenticode worker contract is missing: ${workerContract}`);
}
if (/Task\.Factory\.StartNew\(\s*delegate\s*\{\s*return\s+Authenticode\.VerifyCore/.test(authenticodeSource)) {
  throw new Error('WinVerifyTrust must run only in the killable child process, never in an in-process Task.');
}
if (!source.includes('if (evidence.Status == SignatureStatus.RevocationUnavailable || evidence.Status == SignatureStatus.TimedOut)')) {
  throw new Error('Only the already-attested online refresh may retry provider-unavailable and timed-out evidence.');
}
if (!source.includes('ReadLegacyInstalledPublisherPin(machineRoot, installedExecutables)')
    || !source.includes('EvaluateLegacyInstalledPublisherEvidence(SignatureStatus[] statuses')
    || !source.includes('AuthenticodePurpose.OfflineBaseline')) {
  throw new Error('Legacy installed publisher continuity must inspect every actual protected executable independently.');
}
if (!source.includes('throw new InvalidDataException("Arcane found an installed machine root without its continuity manifest.")')) {
  throw new Error('An existing canonical install with no continuity manifest must fail closed.');
}
const trustVerifyStart = source.indexOf('internal static SignatureEvidence Verify(string file, AuthenticodePurpose purpose)');
const trustVerifyEnd = source.indexOf('private static bool HasTimestampCounterSigner', trustVerifyStart);
const trustVerify = source.slice(trustVerifyStart, trustVerifyEnd);
const firstTrustCall = trustVerify.indexOf('WinVerifyTrust(new IntPtr(-1), ref action, trustData);');
const closePreparation = trustVerify.indexOf('trustData.PrepareToClose();');
const closeTrustCall = trustVerify.indexOf('WinVerifyTrust(new IntPtr(-1), ref action, trustData);', firstTrustCall + 1);
if (firstTrustCall < 0 || closePreparation <= firstTrustCall || closeTrustCall <= closePreparation) {
  throw new Error('WinTrust provider state must be closed after the verification call.');
}
if (!source.includes('eventArgs.CloseReason != CloseReason.WindowsShutDown')) {
  if (!source.includes('eventArgs.CloseReason == CloseReason.WindowsShutDown) ShellWatchdog.Disarm();')) {
    throw new Error('The shell watchdog and emergency desktop must stay disabled during an intentional Windows shutdown or logout.');
  }
}
if (source.includes('Process.Start("explorer.exe")')) {
  throw new Error('The shell fallback must never launch Explorer by a bare executable name.');
}
if (!source.includes('Program.AllowedNavigationPaths') || source.includes('uri.AbsolutePath.StartsWith("/" + Program.AppMode + "/"')) {
  throw new Error('Target hosts must exact-match generated full-document navigation paths and must not allow an app-wide path prefix.');
}
if (source.indexOf('if (ShellWatchdog.TryRun(args)) return;') > source.indexOf('instanceMutex = new Mutex')) {
  throw new Error('The external shell watchdog mode must run before the single-instance shell mutex is acquired.');
}
for (const watchdogContract of [
  'child = Process.Start(start);',
  'if (!ready.WaitOne(TimeSpan.FromSeconds(5)) || child.HasExited)',
  'parent.StartTime.ToUniversalTime().Ticks != expectedStartTicks',
  'if (disarm.WaitOne(250)) return;',
  'Stopwatch heartbeatClock = Stopwatch.StartNew();',
  'TimeSpan heartbeatLimit = TimeSpan.FromSeconds(30);',
  'if (!uiPhase && uiReady.WaitOne(0))',
  'heartbeatClock.Restart();',
  'if (heartbeatClock.Elapsed > heartbeatLimit)',
  'watchdogHeartbeatTimer.Tick += delegate { ShellWatchdog.MarkUiHeartbeat(); };',
  'ShellWatchdog.MarkUiReady();',
  'watchdogHeartbeatTimer.Start();',
  'RecoverAndTerminate(parent, disarm);',
  'bool desktopStarted = false;',
  'if (!desktopStarted) desktopStarted = EmergencyDesktop.TryStart();',
  'try { if (parent.WaitForExit(5000)) return; }',
  'if (!disarm.WaitOne(0)) EmergencyDesktop.TryStart();',
  'else Interlocked.Exchange(ref started, 0);',
  'if (Volatile.Read(ref disarmed) == 0) EmergencyDesktop.TryStart();',
]) {
  if (!source.includes(watchdogContract)) throw new Error(`Windows shell watchdog contract is missing: ${watchdogContract}`);
}
if (!source.includes('Regex.IsMatch(value, @"^Local\\\\Arcane[.]OS[.]Shell[.]Watchdog[.][a-f0-9]{32}[.](Disarm|Ready|Heartbeat|UiReady)$"')) {
  throw new Error('The external shell watchdog must accept only its randomized, local synchronization event names.');
}
const formStart = source.indexOf('public ArcaneForm(');
const navigationCompleted = source.indexOf('webView.CoreWebView2.NavigationCompleted += delegate', formStart);
const navigationReady = source.indexOf('ShellWatchdog.MarkUiReady();', navigationCompleted);
const navigationHeartbeat = source.indexOf('watchdogHeartbeatTimer.Start();', navigationCompleted);
if (formStart < 0 || navigationCompleted < 0 || navigationReady < navigationCompleted
    || navigationHeartbeat < navigationCompleted || !source.slice(navigationCompleted, navigationReady).includes('if (!eventArgs.IsSuccess)')) {
  throw new Error('Shell readiness and UI heartbeats must begin only after successful application navigation.');
}
const shownStart = source.indexOf('Shown += async delegate', formStart);
const initializeAwait = source.indexOf('await InitializeAsync();', shownStart);
const refreshStart = source.indexOf('StartOnlineSecurityRefresh();', shownStart);
if (shownStart < 0 || refreshStart < shownStart || initializeAwait < refreshStart
    || source.slice(formStart, navigationCompleted).includes('watchdogHeartbeatTimer.Start();')) {
  throw new Error('Degraded-security refresh must start independently while pre-navigation watchdog heartbeats remain disabled.');
}
const recoveryStart = source.indexOf('private static void RecoverAndTerminate');
const recoveryEnd = source.indexOf('private static void ValidateEventName', recoveryStart);
const recovery = source.slice(recoveryStart, recoveryEnd > recoveryStart ? recoveryEnd : source.indexOf('internal static class EmergencyDesktop', recoveryStart));
if (recovery.indexOf('EmergencyDesktop.TryStart()') < 0 || recovery.indexOf('parent.Kill();') <= recovery.indexOf('EmergencyDesktop.TryStart()')) {
  throw new Error('The watchdog must launch Explorer before terminating the hung fullscreen Shell.');
}

console.log('Windows WebView2 host source and bridge contract preflight passed.');
