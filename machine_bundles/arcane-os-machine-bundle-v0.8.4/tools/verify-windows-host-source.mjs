import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sourcePath = path.join(root, 'src/hosts/windows/ArcaneHost.cs');
const source = await fs.readFile(sourcePath, 'utf8');
const frontendPath = path.join(root, 'src/frontend/shared/arcane-api.js');
const frontend = await fs.readFile(frontendPath, 'utf8');
const windowsBuilder = await fs.readFile(path.join(root, 'tools/build-windows-webview2.ps1'), 'utf8');
const coreBuilder = await fs.readFile(path.join(root, 'tools/build-core.mjs'), 'utf8');

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
const coreProcessStart = source.indexOf('internal sealed class ArcaneCoreProcess');
const coreProcessSource = source.slice(coreProcessStart);
for (const startupFrameContract of [
  'private const int PendingMessageFrameLimit = 256;',
  'private const int PendingMessageByteLimit = 16 * 1024 * 1024;',
  'private readonly Queue<string> pendingMessages = new Queue<string>();',
  'public event Action<string> MessageReceived',
  'drain = pendingMessages.Count > 0 && !drainingMessages;',
  'pendingMessages.Enqueue(json);',
  'drain = messageReceived != null && !drainingMessages;',
  'json = pendingMessages.Dequeue();',
  'handler(json);',
]) {
  if (!coreProcessSource.includes(startupFrameContract)) {
    throw new Error(`Windows Core startup-frame queue contract is missing: ${startupFrameContract}`);
  }
}
if (coreProcessSource.includes('public event Action<string> MessageReceived;')
    || coreProcessSource.includes('Action<string> handler = MessageReceived;')) {
  throw new Error('Windows Core frames must pass through the bounded startup queue instead of being dropped before subscription.');
}
const queueCall = coreProcessSource.indexOf('PublishMessage(json);');
const directDelivery = coreProcessSource.indexOf('handler(json);');
if (queueCall < 0 || directDelivery < queueCall) {
  throw new Error('Windows Core frames must be queued before their ordered delivery path is used.');
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
for (const firstBootContract of [
  'FirstBoot.Run(releaseSecurity.ReleaseRoot);',
  'internal static class FirstBoot',
  'private static readonly Step[] Steps',
  'new Step(LockScreenStepId, ApplyWindowsLockScreen)',
  '!IsInstalledReleaseRoot(releaseRoot)',
  'Path.GetFullPath(Path.Combine(programFiles, "Arcane OS"))',
  '@"Software\\Arcane OS\\FirstBoot"',
  'markers.GetValue(step.Id, 0, RegistryValueOptions.DoNotExpandEnvironmentNames)',
  'markers.SetValue(step.Id, 1, RegistryValueKind.DWord);',
  'Path.Combine(root, "app", "shared", "arcane-lock-screen-v1.png")',
  'StorageFile.GetFileFromPathAsync(imagePath).AsTask().GetAwaiter().GetResult();',
  'LockScreen.SetImageFileAsync(image).AsTask().GetAwaiter().GetResult();',
  'Path.Combine(folder, "first-boot.log")',
]) {
  if (!source.includes(firstBootContract)) throw new Error(`Windows per-user first-boot contract is missing: ${firstBootContract}`);
}
const releaseVerification = source.indexOf('releaseSecurity = ReleaseSecurityVerifier.Verify(args);');
const firstBootRun = source.indexOf('FirstBoot.Run(releaseSecurity.ReleaseRoot);');
const applicationRun = source.indexOf('Application.Run(new ArcaneForm(args, releaseSecurity, startupBackdrop));');
if (releaseVerification < 0 || firstBootRun <= releaseVerification || applicationRun <= firstBootRun) {
  throw new Error('Windows first-boot steps must run from the Shell only after release verification and before the Shell UI starts.');
}
const backdropShow = source.indexOf('if (AppMode == "shell") startupBackdrop = StartupBackdrop.ShowNow();');
const backdropStart = source.indexOf('internal sealed class StartupBackdrop');
const backdropEnd = source.indexOf('internal sealed class ArcaneForm', backdropStart);
const backdropSource = source.slice(backdropStart, backdropEnd);
if (backdropShow < 0 || backdropShow > releaseVerification || backdropStart < 0
    || !backdropSource.includes('BackColor = Program.StartupBackgroundColor;')
    || !backdropSource.includes('FormBorderStyle = FormBorderStyle.None;')
    || !backdropSource.includes('Application.DoEvents();')) {
  throw new Error('The Shell must paint its compiled startup backdrop before release verification begins.');
}
for (const forbiddenBackdropInput of ['File.', 'Directory.', 'Registry.', 'WebView2', 'ArcaneCoreProcess']) {
  if (backdropSource.includes(forbiddenBackdropInput)) throw new Error(`The pre-verification backdrop must not consume external input: ${forbiddenBackdropInput}`);
}
for (const buildContract of [
  'arcane-lock-screen-v1.png',
  'Windows Kits\\10\\UnionMetadata',
  'System.Runtime.WindowsRuntime.dll',
  "if ($define -eq 'ARCANE_SHELL')",
  '"/reference:$windowsMetadata"',
  '"/reference:$windowsRuntime"',
  '"/reference:$systemRuntimeFacade"',
]) {
  const buildSource = buildContract === 'arcane-lock-screen-v1.png' ? coreBuilder : windowsBuilder;
  if (!buildSource.includes(buildContract)) throw new Error(`Windows first-boot build contract is missing: ${buildContract}`);
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
const installedPinStart = source.indexOf('private static string ReadInstalledPublisherPin()');
const installedPinEnd = source.indexOf('private static string ReadLegacyInstalledPublisherPin', installedPinStart);
const installedPinSource = source.slice(installedPinStart, installedPinEnd);
for (const accessFailureContract of [
  'File.GetAttributes(machineRoot);',
  'File.GetAttributes(manifestPath);',
  'catch (UnauthorizedAccessException error)',
  'catch (System.Security.SecurityException error)',
  'throw new InstalledTrustStateAccessException(manifestPath, error);',
]) {
  if (!installedPinSource.includes(accessFailureContract)) {
    throw new Error(`Installed publisher trust access must fail closed: ${accessFailureContract}`);
  }
}
if (installedPinSource.includes('Directory.Exists(machineRoot)') || installedPinSource.includes('File.Exists(manifestPath)')) {
  throw new Error('Existence probes must not hide access-denied installed trust state as a missing installation.');
}
for (const diagnosticContract of [
  'catch (InstalledTrustStateAccessException error)',
  'MessageBox.Show(error.Message, "Arcane could not start"',
  'unreadable trust state is never treated as permission to run an unsigned local release',
  'repair/reinstall Arcane OS from a complete verified release',
]) {
  if (!source.includes(diagnosticContract)) throw new Error(`Installed trust repair diagnostic is missing: ${diagnosticContract}`);
}
const trustAccessCatch = source.indexOf('catch (InstalledTrustStateAccessException error)');
const genericStartupCatch = source.indexOf('catch (Exception error)', trustAccessCatch);
if (trustAccessCatch < 0 || genericStartupCatch < trustAccessCatch) {
  throw new Error('The user-facing installed trust diagnostic must be handled before the generic startup error dialog.');
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
const formBackground = source.indexOf('BackColor = Program.StartupBackgroundColor;', formStart);
const viewBackground = source.indexOf('BackColor = Program.StartupBackgroundColor,', formBackground + 1);
const controlsAdd = source.indexOf('Controls.Add(webView);', formStart);
if (!source.includes('Color.FromArgb(3, 5, 10)') || formBackground < formStart
    || viewBackground < formBackground || controlsAdd < viewBackground) {
  throw new Error('The Windows host must paint the configured Arcane startup surface before adding WebView2.');
}
for (const nativeThemeContract of [
  'internal static class NativeWindowTheme',
  'DwmUseImmersiveDarkMode = 20',
  'DwmCaptionColor = 35',
  'SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;',
  'NativeWindowTheme.Apply(Handle);',
  'NativeWindowTheme.AppearanceChangedEvent();',
  '\\\"event\\\":\\\"appearance.changed\\\"',
]) {
  if (!source.includes(nativeThemeContract)) throw new Error(`The Windows native appearance contract is missing: ${nativeThemeContract}`);
}
const controllerOptions = source.indexOf('CoreWebView2ControllerOptions controllerOptions = environment.CreateCoreWebView2ControllerOptions();', formStart);
const controllerBackground = source.indexOf('controllerOptions.DefaultBackgroundColor = Program.StartupBackgroundColor;', controllerOptions);
const controllerInitialization = source.indexOf('await webView.EnsureCoreWebView2Async(environment, controllerOptions);', controllerBackground);
if (controllerOptions < formStart || controllerBackground < controllerOptions || controllerInitialization < controllerBackground) {
  throw new Error('WebView2 must receive the configured Arcane background before its controller is created.');
}
const navigationCompleted = source.indexOf('webView.CoreWebView2.NavigationCompleted += delegate', formStart);
const navigationReady = source.indexOf('ShellWatchdog.MarkUiReady();', navigationCompleted);
const navigationHeartbeat = source.indexOf('watchdogHeartbeatTimer.Start();', navigationCompleted);
if (formStart < 0 || navigationCompleted < 0 || navigationReady < navigationCompleted
    || navigationHeartbeat < navigationCompleted || !source.slice(navigationCompleted, navigationReady).includes('if (!eventArgs.IsSuccess)')) {
  throw new Error('Shell readiness and UI heartbeats must begin only after successful application navigation.');
}
const loadStart = source.indexOf('Load += async delegate', formStart);
const initializeAwait = source.indexOf('await InitializeAsync();', loadStart);
const refreshStart = source.indexOf('StartOnlineSecurityRefresh();', loadStart);
if (loadStart < 0 || refreshStart < loadStart || initializeAwait < refreshStart
    || source.slice(formStart, navigationCompleted).includes('watchdogHeartbeatTimer.Start();')) {
  throw new Error('WebView initialization and degraded-security refresh must begin before presentation while pre-navigation watchdog heartbeats remain disabled.');
}
const recoveryStart = source.indexOf('private static void RecoverAndTerminate');
const recoveryEnd = source.indexOf('private static void ValidateEventName', recoveryStart);
const recovery = source.slice(recoveryStart, recoveryEnd > recoveryStart ? recoveryEnd : source.indexOf('internal static class EmergencyDesktop', recoveryStart));
if (recovery.indexOf('EmergencyDesktop.TryStart()') < 0 || recovery.indexOf('parent.Kill();') <= recovery.indexOf('EmergencyDesktop.TryStart()')) {
  throw new Error('The watchdog must launch Explorer before terminating the hung fullscreen Shell.');
}

console.log('Windows WebView2 host source and bridge contract preflight passed.');
