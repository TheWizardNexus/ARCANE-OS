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
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
#if ARCANE_SHELL
using System.Runtime.InteropServices.WindowsRuntime;
using StorageFile = Windows.Storage.StorageFile;
using LockScreen = Windows.System.UserProfile.LockScreen;
#endif

namespace ArcaneOS
{
    internal static class Program
    {
#if ARCANE_TARGET_APP
        internal const string AppMode = ArcaneTarget.AppMode;
        internal const string ProductName = ArcaneTarget.ProductName;
        internal const string AppId = ArcaneTarget.AppId;
        internal const bool AllowMicrophone = ArcaneTarget.AllowMicrophone;
        internal const bool AllowExternalOpen = ArcaneTarget.AllowExternalOpen;
        internal static readonly string[] AllowedNavigationPaths = ArcaneTarget.AllowedNavigationPaths;
#elif ARCANE_SHELL
        internal const string AppMode = "shell";
        internal const string ProductName = "Arcane OS";
        internal const string AppId = "Arcane.OS.Shell";
        internal const bool AllowMicrophone = true;
        internal const bool AllowExternalOpen = true;
#else
        internal const string AppMode = "provisioner";
        internal const string ProductName = "Arcane OS Provisioner";
        internal const string AppId = "Arcane.OS.Provisioner";
        internal const bool AllowMicrophone = false;
        internal const bool AllowExternalOpen = false;
#endif
        internal static readonly Color StartupBackgroundColor =
            AppMode == "shell" || AppMode == "provisioner" ? Color.FromArgb(3, 5, 10) : SystemColors.Window;
        private static Mutex instanceMutex;

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int SetCurrentProcessExplicitAppUserModelID(string appID);

        [STAThread]
        private static void Main(string[] args)
        {
            if (AuthenticodeProbe.TryRun(args)) return;
            if (PublisherAttestationProbe.TryRun(args)) return;
            if (ShellWatchdog.TryRun(args)) return;

            bool created;
            instanceMutex = new Mutex(true, "Local\\" + AppId + ".SingleInstance", out created);
            if (!created) return;

            ReleaseSecurityResult releaseSecurity = null;
            StartupBackdrop startupBackdrop = null;
            try
            {
                if (AppMode == "shell") ShellWatchdog.Start();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                if (AppMode == "shell") startupBackdrop = StartupBackdrop.ShowNow();
                releaseSecurity = ReleaseSecurityVerifier.Verify(args, startupBackdrop);
                if (AppMode == "shell") ShellWatchdog.MarkVerifierHeartbeat();
#if ARCANE_SHELL
                FirstBoot.Run(releaseSecurity.ReleaseRoot, startupBackdrop);
#endif
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
                if (startupBackdrop != null) startupBackdrop.BeginStage("form", "Constructing the trusted shell window…");
                ArcaneForm form = new ArcaneForm(args, releaseSecurity, startupBackdrop);
                if (startupBackdrop != null) startupBackdrop.CompleteStage("form", "Trusted shell window constructed.");
                Application.Run(form);
                startupBackdrop = null;
            }
            catch (InstalledTrustStateAccessException error)
            {
                StartupBackdrop.CloseSafely(startupBackdrop);
                if (AppMode == "shell") EmergencyDesktop.TryStart();
                MessageBox.Show(error.Message, "Arcane could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch (Exception error)
            {
                StartupBackdrop.CloseSafely(startupBackdrop);
                if (AppMode == "shell") EmergencyDesktop.TryStart();
                MessageBox.Show(error.ToString(), "Arcane could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                StartupBackdrop.CloseSafely(startupBackdrop);
                if (releaseSecurity != null) releaseSecurity.Dispose();
                GC.KeepAlive(instanceMutex);
            }
        }
    }

#if ARCANE_SHELL
    internal static class FirstBoot
    {
        private const string MarkerKeyPath = @"Software\Arcane OS\FirstBoot";
        private const string LockScreenStepId = "windows-lock-screen-v1";

        private sealed class Step
        {
            internal readonly string Id;
            internal readonly Action<string> Apply;

            internal Step(string id, Action<string> apply)
            {
                Id = id;
                Apply = apply;
            }
        }

        private static readonly Step[] Steps = new Step[]
        {
            new Step(LockScreenStepId, ApplyWindowsLockScreen),
        };

        internal static void Run(string releaseRoot, StartupBackdrop startupBackdrop)
        {
            if (Program.AppMode != "shell" || !IsInstalledReleaseRoot(releaseRoot))
            {
                if (startupBackdrop != null) startupBackdrop.SkipStage("firstboot", "No installed-user first-boot work is required.");
                return;
            }
            if (startupBackdrop != null) startupBackdrop.BeginStage("firstboot", "Checking idempotent per-user first-boot steps…");
            bool complete = true;
            foreach (Step step in Steps) if (!RunStep(step, releaseRoot)) complete = false;
            if (startupBackdrop != null)
            {
                if (complete) startupBackdrop.CompleteStage("firstboot", "Per-user first-boot steps are complete.");
                else startupBackdrop.FailStage("firstboot", "A noncritical first-boot step could not finish and will retry at the next sign-in.");
            }
        }

        private static bool IsInstalledReleaseRoot(string releaseRoot)
        {
            if (String.IsNullOrWhiteSpace(releaseRoot)) return false;
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (String.IsNullOrWhiteSpace(programFiles)) return false;
            string expected = Path.GetFullPath(Path.Combine(programFiles, "Arcane OS"))
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string actual = Path.GetFullPath(releaseRoot)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);
        }

        private static bool RunStep(Step step, string releaseRoot)
        {
            try
            {
                using (RegistryKey markers = Registry.CurrentUser.CreateSubKey(MarkerKeyPath, true))
                {
                    if (markers == null) throw new UnauthorizedAccessException("Arcane could not open its per-user first-boot marker key.");
                    object completed = markers.GetValue(step.Id, 0, RegistryValueOptions.DoNotExpandEnvironmentNames);
                    if (completed is int && (int)completed == 1) return true;
                    step.Apply(releaseRoot);
                    markers.SetValue(step.Id, 1, RegistryValueKind.DWord);
                    markers.Flush();
                }
                WriteLog("completed", step.Id, null);
                return true;
            }
            catch (Exception error)
            {
                // A personalization failure must not strand the user outside a usable Shell.
                // The missing completion marker lets the idempotent step retry at next sign-in.
                WriteLog("failed", step.Id, error);
                return false;
            }
        }

        private static void ApplyWindowsLockScreen(string releaseRoot)
        {
            string root = Path.GetFullPath(releaseRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string imagePath = Path.GetFullPath(Path.Combine(root, "app", "shared", "arcane-lock-screen-v1.png"));
            string rootPrefix = root + Path.DirectorySeparatorChar;
            if (!imagePath.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("The Arcane lock-screen image resolved outside the verified installation.");
            if (!File.Exists(imagePath))
                throw new FileNotFoundException("The verified Arcane lock-screen image is missing.", imagePath);

            StorageFile image = StorageFile.GetFileFromPathAsync(imagePath).AsTask().GetAwaiter().GetResult();
            LockScreen.SetImageFileAsync(image).AsTask().GetAwaiter().GetResult();
        }

        private static void WriteLog(string disposition, string stepId, Exception error)
        {
            try
            {
                string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Arcane OS", "Logs");
                Directory.CreateDirectory(folder);
                string message = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                    + " first-boot " + disposition + " " + stepId;
                if (error != null) message += " " + error.GetType().Name + ": " + error.Message.Replace("\r", " ").Replace("\n", " ");
                File.AppendAllText(Path.Combine(folder, "first-boot.log"), message + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }
    }
#endif

    internal static class PublisherAttestationProbe
    {
        private const string ProbeArgument = "--arcane-publisher-attestation-probe";
        internal static bool TryRun(string[] args)
        {
            if (args == null || args.Length == 0 || !String.Equals(args[0], ProbeArgument, StringComparison.Ordinal)) return false;
            try
            {
                if (Program.AppMode != "provisioner" || args.Length != 2 || String.IsNullOrWhiteSpace(args[1]))
                    throw new ArgumentException("Arcane rejected a malformed publisher-attestation probe request.");
                using (ReleaseSecurityResult probeSecurity = ReleaseSecurityVerifier.Verify(new string[0]))
                {
                    if (!String.Equals(probeSecurity.SecurityMode, "publisher-verified", StringComparison.Ordinal)
                        || !String.Equals(probeSecurity.RevocationStatus, "online-good", StringComparison.Ordinal)
                        || !probeSecurity.TimestampVerified)
                        throw new InvalidDataException("Arcane publisher-attestation probe did not pass strict online self-verification.");
                    if (String.Equals(probeSecurity.PublisherTrustSource, "fresh-unpinned", StringComparison.Ordinal))
                    {
                        WindowsPrincipal principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
                        if (!principal.IsInRole(WindowsBuiltInRole.Administrator))
                            throw new InvalidDataException("An unpinned first-use publisher probe requires an administrator-approved transaction.");
                    }
                    string attestation = ReleaseSecurityVerifier.CreateStrictPublisherAttestation(args[1], probeSecurity);
                    Console.Out.Write(attestation);
                }
                Environment.ExitCode = 0;
            }
            catch (Exception error)
            {
                Console.Error.Write(error.ToString());
                Environment.ExitCode = 1;
            }
            return true;
        }
    }

    internal static class ShellWatchdog
    {
        private const string WatchdogArgument = "--arcane-shell-watchdog";
        private const string EventPrefix = "Local\\Arcane.OS.Shell.Watchdog.";
        private static EventWaitHandle disarmEvent;
        private static EventWaitHandle heartbeatEvent;
        private static EventWaitHandle uiReadyEvent;
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
            string heartbeatName = EventPrefix + token + ".Heartbeat";
            string uiReadyName = EventPrefix + token + ".UiReady";
            bool disarmCreated;
            bool readyCreated;
            bool heartbeatCreated;
            bool uiReadyCreated;
            EventWaitHandle localDisarm = null;
            EventWaitHandle ready = null;
            EventWaitHandle heartbeat = null;
            EventWaitHandle uiReady = null;
            Process child = null;
            try
            {
                using (Process current = Process.GetCurrentProcess())
                {
                    localDisarm = new EventWaitHandle(false, EventResetMode.ManualReset, disarmName, out disarmCreated);
                    ready = new EventWaitHandle(false, EventResetMode.ManualReset, readyName, out readyCreated);
                    heartbeat = new EventWaitHandle(false, EventResetMode.AutoReset, heartbeatName, out heartbeatCreated);
                    uiReady = new EventWaitHandle(false, EventResetMode.ManualReset, uiReadyName, out uiReadyCreated);
                    if (!disarmCreated || !readyCreated || !heartbeatCreated || !uiReadyCreated) throw new InvalidOperationException("Arcane could not create private shell-watchdog synchronization events.");

                    ProcessStartInfo start = new ProcessStartInfo(Application.ExecutablePath)
                    {
                        Arguments = WatchdogArgument + " "
                            + current.Id.ToString(CultureInfo.InvariantCulture) + " "
                            + current.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) + " "
                            + disarmName + " " + readyName + " " + heartbeatName + " " + uiReadyName,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden,
                        WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory
                    };
                    child = Process.Start(start);
                    if (child == null) throw new InvalidOperationException("Microsoft NT did not start the Arcane shell watchdog.");
                    if (!ready.WaitOne(TimeSpan.FromSeconds(5)) || child.HasExited)
                        throw new InvalidOperationException("The Arcane shell watchdog did not confirm that it is monitoring this shell.");

                    disarmEvent = localDisarm;
                    heartbeatEvent = heartbeat;
                    uiReadyEvent = uiReady;
                    watchdogProcess = child;
                    localDisarm = null;
                    heartbeat = null;
                    uiReady = null;
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
                if (heartbeat != null) heartbeat.Dispose();
                if (uiReady != null) uiReady.Dispose();
            }
        }

        internal static void MarkVerifierHeartbeat()
        {
            try { if (heartbeatEvent != null) heartbeatEvent.Set(); } catch { }
        }

        internal static void MarkUiReady()
        {
            try { if (uiReadyEvent != null) uiReadyEvent.Set(); } catch { }
            MarkVerifierHeartbeat();
        }

        internal static void MarkUiHeartbeat()
        {
            try { if (heartbeatEvent != null) heartbeatEvent.Set(); } catch { }
        }

        internal static void Disarm()
        {
            if (Interlocked.Exchange(ref disarmed, 1) != 0) return;
            try { if (disarmEvent != null) disarmEvent.Set(); } catch { }
            try { if (disarmEvent != null) disarmEvent.Dispose(); } catch { }
            try { if (heartbeatEvent != null) heartbeatEvent.Dispose(); } catch { }
            try { if (uiReadyEvent != null) uiReadyEvent.Dispose(); } catch { }
            try { if (watchdogProcess != null) watchdogProcess.Dispose(); } catch { }
            disarmEvent = null;
            heartbeatEvent = null;
            uiReadyEvent = null;
            watchdogProcess = null;
        }

        private static void Run(string[] args)
        {
            if (args.Length != 7) throw new ArgumentException("Invalid Arcane shell watchdog arguments.");
            int parentId;
            long expectedStartTicks;
            if (!Int32.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out parentId) || parentId <= 0)
                throw new ArgumentException("Invalid Arcane shell watchdog parent process.");
            if (!Int64.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out expectedStartTicks) || expectedStartTicks <= 0)
                throw new ArgumentException("Invalid Arcane shell watchdog process identity.");
            ValidateEventName(args[3]);
            ValidateEventName(args[4]);
            ValidateEventName(args[5]);
            ValidateEventName(args[6]);

            using (EventWaitHandle disarm = EventWaitHandle.OpenExisting(args[3]))
            using (EventWaitHandle ready = EventWaitHandle.OpenExisting(args[4]))
            using (EventWaitHandle heartbeat = EventWaitHandle.OpenExisting(args[5]))
            using (EventWaitHandle uiReady = EventWaitHandle.OpenExisting(args[6]))
            using (Process parent = Process.GetProcessById(parentId))
            {
                if (parent.StartTime.ToUniversalTime().Ticks != expectedStartTicks)
                    throw new InvalidOperationException("Arcane shell watchdog rejected a reused process identifier.");
                ready.Set();
                Stopwatch heartbeatClock = Stopwatch.StartNew();
                TimeSpan heartbeatLimit = TimeSpan.FromSeconds(30);
                bool uiPhase = false;
                while (true)
                {
                    if (disarm.WaitOne(250)) return;
                    if (!uiPhase && uiReady.WaitOne(0))
                    {
                        uiPhase = true;
                        heartbeatLimit = TimeSpan.FromSeconds(15);
                        heartbeatClock.Restart();
                    }
                    if (heartbeat.WaitOne(0))
                    {
                        heartbeatLimit = TimeSpan.FromSeconds(uiPhase ? 15 : 30);
                        heartbeatClock.Restart();
                    }
                    if (heartbeatClock.Elapsed > heartbeatLimit)
                    {
                        RecoverAndTerminate(parent, disarm);
                        return;
                    }
                    if (parent.WaitForExit(0))
                    {
                        if (!disarm.WaitOne(0)) EmergencyDesktop.TryStart();
                        return;
                    }
                }
            }
        }

        private static void ValidateEventName(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || !value.StartsWith(EventPrefix, StringComparison.Ordinal)
                || value.Length > 160 || !Regex.IsMatch(value, @"^Local\\Arcane[.]OS[.]Shell[.]Watchdog[.][a-f0-9]{32}[.](Disarm|Ready|Heartbeat|UiReady)$", RegexOptions.CultureInvariant))
                throw new ArgumentException("Invalid Arcane shell watchdog event name.");
        }

        private static void RecoverAndTerminate(Process parent, EventWaitHandle disarm)
        {
            bool desktopStarted = false;
            while (!parent.WaitForExit(0))
            {
                if (disarm.WaitOne(0)) return;
                if (!desktopStarted) desktopStarted = EmergencyDesktop.TryStart();
                if (desktopStarted)
                {
                    if (disarm.WaitOne(0)) return;
                    try { parent.Kill(); }
                    catch { }
                    try { if (parent.WaitForExit(5000)) return; }
                    catch { }
                }
                if (disarm.WaitOne(2000)) return;
            }
        }
    }

    internal static class EmergencyDesktop
    {
        private static int started;

        internal static bool TryStart()
        {
            if (Program.AppMode != "shell" || Interlocked.Exchange(ref started, 1) != 0) return false;
            bool launched = false;
            try
            {
                string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
                string explorer = Path.Combine(windows, "explorer.exe");
                if (!Path.IsPathRooted(explorer) || !File.Exists(explorer)) return false;
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
                else Interlocked.Exchange(ref started, 0);
            }
            return launched;
        }
    }

    internal sealed class ReleaseSecurityResult : IDisposable
    {
        private readonly List<FileStream> retainedFiles;
        private readonly List<RetainedDirectoryHandle> retainedDirectories;
        private readonly List<string> verifiedExecutables;
        private readonly Stopwatch degradedLifetimeClock;
        private readonly TimeSpan degradedLifetimeAtVerification;
        internal string ReleaseRoot { get; private set; }
        internal string SecurityMode { get; private set; }
        internal string ContentBinding { get; private set; }
        internal string SignerThumbprint { get; private set; }
        internal string VerifiedAtUtc { get; private set; }
        internal string RevocationStatus { get; private set; }
        internal string PublisherTrustSource { get; private set; }
        internal bool TimestampVerified { get; private set; }
        internal string[] VerifiedExecutables { get { return verifiedExecutables.ToArray(); } }
        internal bool IsUnsignedLocalTest { get { return String.Equals(SecurityMode, "unsigned-local-test", StringComparison.Ordinal); } }

        internal ReleaseSecurityResult(
            string releaseRoot,
            string securityMode,
            string contentBinding,
            string signerThumbprint,
            string verifiedAtUtc,
            string revocationStatus,
            string publisherTrustSource,
            bool timestampVerified,
            List<string> executables,
            List<FileStream> verifiedFiles,
            List<RetainedDirectoryHandle> verifiedDirectories)
        {
            if (String.IsNullOrWhiteSpace(releaseRoot)) throw new ArgumentException("A verified release root is required.", "releaseRoot");
            if (securityMode != "publisher-verified" && securityMode != "unsigned-local-test") throw new ArgumentException("Invalid Arcane release security mode.", "securityMode");
            ReleaseRoot = releaseRoot;
            SecurityMode = securityMode;
            ContentBinding = contentBinding;
            SignerThumbprint = signerThumbprint;
            VerifiedAtUtc = verifiedAtUtc;
            RevocationStatus = revocationStatus;
            PublisherTrustSource = publisherTrustSource;
            TimestampVerified = timestampVerified;
            verifiedExecutables = executables == null ? new List<string>() : new List<string>(executables);
            if (securityMode == "publisher-verified")
            {
                if (String.IsNullOrWhiteSpace(contentBinding) || String.IsNullOrWhiteSpace(signerThumbprint)
                    || String.IsNullOrWhiteSpace(verifiedAtUtc) || String.IsNullOrWhiteSpace(revocationStatus)
                    || String.IsNullOrWhiteSpace(publisherTrustSource) || !timestampVerified)
                    throw new ArgumentException("Publisher verification must include complete trusted evidence.", "securityMode");
                if (String.Equals(revocationStatus, "attested-degraded", StringComparison.Ordinal))
                {
                    DateTimeOffset now = DateTimeOffset.UtcNow;
                    degradedLifetimeAtVerification = ReleaseSecurityVerifier.ValidateDegradedVerificationTime(verifiedAtUtc, now) - now;
                    degradedLifetimeClock = Stopwatch.StartNew();
                }
            }
            else if (!String.IsNullOrEmpty(signerThumbprint) || !String.IsNullOrEmpty(verifiedAtUtc)
                || !String.IsNullOrEmpty(revocationStatus) || !String.IsNullOrEmpty(publisherTrustSource) || timestampVerified)
                throw new ArgumentException("Unsigned local-test verification cannot carry publisher evidence.", "securityMode");
            retainedFiles = verifiedFiles ?? new List<FileStream>();
            retainedDirectories = verifiedDirectories ?? new List<RetainedDirectoryHandle>();
        }

        internal TimeSpan RemainingDegradedLifetime(DateTimeOffset nowUtc)
        {
            DateTimeOffset expiresAt = ReleaseSecurityVerifier.ValidateDegradedVerificationTime(VerifiedAtUtc, nowUtc);
            TimeSpan wallRemaining = expiresAt - nowUtc;
            if (degradedLifetimeClock == null) return wallRemaining;
            TimeSpan monotonicRemaining = degradedLifetimeAtVerification - degradedLifetimeClock.Elapsed;
            if (monotonicRemaining <= TimeSpan.Zero)
                throw new InvalidDataException("Arcane publisher attestation expired according to the monotonic runtime deadline.");
            return wallRemaining <= monotonicRemaining ? wallRemaining : monotonicRemaining;
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

    internal sealed class InstalledTrustStateAccessException : IOException
    {
        internal InstalledTrustStateAccessException(string manifestPath, Exception innerException)
            : base(
                "Arcane cannot read its protected installed trust state at '" + manifestPath + "'. "
                + "Startup is blocked, and unreadable trust state is never treated as permission to run an unsigned local release. "
                + "An administrator must repair the Arcane OS installation permissions, or repair/reinstall Arcane OS from a complete verified release.",
                innerException)
        {
        }
    }

    internal static class ReleaseSecurityVerifier
    {
        private const string BindingMetadataKey = "ArcaneContentBinding";
        private const string PublisherMetadataKey = "ArcanePublisherBinding";
        private const string PublisherMarkerPrefix = "ARCANE-PUBLISHER|1|";
        // Construct the local-test sentinel at runtime so the complete publisher
        // marker appears exactly once in the binary: in AssemblyMetadata.
        private static readonly string UnsignedPublisherMarker = String.Concat(PublisherMarkerPrefix, "UNSIGNED-", "LOCAL-", "TEST");
        private const string MachineManifestName = "arcane-machine-content.json";
        private const string TargetManifestName = "arcane-app-content.json";
        private static readonly Regex HashPattern = new Regex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
        private static readonly Regex AppIdPattern = new Regex("^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", RegexOptions.CultureInvariant);
        private static readonly Regex ReservedNamePattern = new Regex("^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.].*)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly TimeSpan PublisherAttestationMaximumAge = TimeSpan.FromDays(30);
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

        internal static ReleaseSecurityResult Verify(string[] args, StartupBackdrop startupBackdrop = null)
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
            ShellWatchdog.MarkVerifierHeartbeat();
            string marker = ReadOwnMetadataMarker(BindingMetadataKey, expectedPrefix, "content binding");
            string publisherMarker = ReadOwnMetadataMarker(PublisherMetadataKey, PublisherMarkerPrefix, "publisher binding");
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
                if (startupBackdrop != null) startupBackdrop.BeginStage("walk", "Walking the verified release directory…");
                RetainDirectoryTree(root, root, retainedDirectoriesByPath, retainedDirectories, startupBackdrop);
                if (startupBackdrop != null)
                {
                    startupBackdrop.CompleteStage("walk", "Release directory walk complete.");
                    startupBackdrop.BeginStage("handles", retainedDirectories.Count.ToString(CultureInfo.InvariantCulture) + " protected directory handles retained; binding manifest files next.");
                }
                ShellWatchdog.MarkVerifierHeartbeat();
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
                ShellWatchdog.MarkVerifierHeartbeat();
                RetainAndRecheck(root, files, excludedHosts, retainedByPath, retained, startupBackdrop);
                VerifyRetainedDirectoryIdentities(retainedDirectories);
                ShellWatchdog.MarkVerifierHeartbeat();
#if !ARCANE_TARGET_APP
                RequireEmbeddedMarker(retainedByPath[Path.GetFullPath(otherHostPath)], marker);
                RequireEmbeddedMarker(retainedByPath[Path.GetFullPath(otherHostPath)], publisherMarker);
#endif
                bool allowUnsigned = HasExactArgument(args, "--allow-unsigned-local-release");
                bool canonicalInstalled = IsCanonicalInstalledRelease(root);
                ExecutableSecurityResult security = VerifyExecutableSignatures(
                    executables,
                    allowUnsigned,
                    publisherMarker,
                    marker,
                    root,
                    canonicalInstalled,
                    retainedByPath,
                    retained,
                    startupBackdrop);
                ShellWatchdog.MarkVerifierHeartbeat();
                return new ReleaseSecurityResult(
                    root,
                    security.SecurityMode,
                    marker,
                    security.SignerThumbprint,
                    security.VerifiedAtUtc,
                    security.RevocationStatus,
                    security.PublisherTrustSource,
                    security.TimestampVerified,
                    executables,
                    retained,
                    retainedDirectories);
            }
            catch
            {
                foreach (FileStream file in retained) file.Dispose();
                foreach (RetainedDirectoryHandle directory in retainedDirectories) directory.Dispose();
                throw;
            }
        }

        internal static bool RefreshOnline(ReleaseSecurityResult security)
        {
            if (security == null || !String.Equals(security.SecurityMode, "publisher-verified", StringComparison.Ordinal)
                || !String.Equals(security.RevocationStatus, "attested-degraded", StringComparison.Ordinal)) return true;
            security.RemainingDegradedLifetime(DateTimeOffset.UtcNow);
            string[] executables = security.VerifiedExecutables;
            if (executables.Length == 0) throw new InvalidDataException("Arcane cannot refresh an empty publisher verification set.");
            bool unavailable = false;
            foreach (string executable in executables)
            {
                AssertRegularFile(executable, "Arcane executable");
                SignatureEvidence evidence = Authenticode.Verify(executable, AuthenticodePurpose.StrictOnline);
                if (evidence.Status == SignatureStatus.RevocationUnavailable || evidence.Status == SignatureStatus.TimedOut) { unavailable = true; continue; }
                if (evidence.Status == SignatureStatus.Revoked)
                    throw new InvalidDataException("Arcane online refresh found an explicitly revoked signature on " + Path.GetFileName(executable) + ".");
                if (evidence.Status != SignatureStatus.Valid || !evidence.TimestampVerified
                    || !String.Equals(evidence.SignerThumbprint, security.SignerThumbprint, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Arcane online refresh rejected " + Path.GetFileName(executable) + ": " + evidence.Details);
            }
            return !unavailable;
        }

        internal static DateTimeOffset ValidateDegradedVerificationTime(string verifiedAtUtc, DateTimeOffset nowUtc)
        {
            DateTimeOffset verifiedTime;
            if (String.IsNullOrWhiteSpace(verifiedAtUtc) || !verifiedAtUtc.EndsWith("Z", StringComparison.Ordinal)
                || !DateTimeOffset.TryParse(verifiedAtUtc, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out verifiedTime)
                || verifiedTime > nowUtc.AddMinutes(5))
                throw new InvalidDataException("Arcane publisher attestation has an invalid verification time.");
            DateTimeOffset expiresAt = verifiedTime.Add(PublisherAttestationMaximumAge);
            if (expiresAt <= nowUtc) throw new InvalidDataException("Arcane publisher attestation has expired during degraded verification.");
            return expiresAt;
        }

        internal static TimeSpan CapDegradedRetryDelay(string verifiedAtUtc, DateTimeOffset nowUtc, TimeSpan proposedDelay)
        {
            if (proposedDelay <= TimeSpan.Zero) throw new ArgumentOutOfRangeException("proposedDelay");
            TimeSpan remaining = ValidateDegradedVerificationTime(verifiedAtUtc, nowUtc) - nowUtc;
            return proposedDelay <= remaining ? proposedDelay : remaining;
        }

        internal static string CreateStrictPublisherAttestation(string requestedRoot, ReleaseSecurityResult probeSecurity)
        {
            if (probeSecurity == null) throw new ArgumentNullException("probeSecurity");
            string root = Path.GetFullPath(requestedRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            AssertRegularDirectory(root, "publisher-attestation stage");
            string version = InformationalVersion();
            string manifestPath = Path.Combine(root, MachineManifestName);
            Dictionary<string, FileStream> retainedByPath = new Dictionary<string, FileStream>(StringComparer.OrdinalIgnoreCase);
            List<FileStream> retained = new List<FileStream>();
            Dictionary<string, RetainedDirectoryHandle> retainedDirectoriesByPath = new Dictionary<string, RetainedDirectoryHandle>(StringComparer.OrdinalIgnoreCase);
            List<RetainedDirectoryHandle> retainedDirectories = new List<RetainedDirectoryHandle>();
            try
            {
                RetainDirectoryTree(root, root, retainedDirectoriesByPath, retainedDirectories);
                FileStream retainedManifest = RetainFile(manifestPath, retainedByPath, retained);
                string manifestHash = HashStream(retainedManifest);
                string machineBinding = "ARCANE-MACHINE-BINDING|1|" + version + "|" + manifestHash;
                Dictionary<string, object> manifest = ParseObject(ReadRetainedFile(retainedManifest, 64 * 1024 * 1024, MachineManifestName), MachineManifestName);
                List<ManifestFile> files = VerifyMachineManifest(root, manifest, version);
                string provisionerPath = Path.Combine(root, "bin", "ArcaneProvisioner.exe");
                string shellPath = Path.Combine(root, "bin", "ArcaneShell.exe");
                RequireCanonicalFile(root, "bin/ArcaneProvisioner.exe");
                RequireCanonicalFile(root, "bin/ArcaneShell.exe");
                List<string> executables = ExecutableFiles(files, root);
                executables.Add(provisionerPath);
                executables.Add(shellPath);
                RetainAndRecheck(root, files, new List<string> { provisionerPath, shellPath }, retainedByPath, retained);
                VerifyRetainedDirectoryIdentities(retainedDirectories);
                RequireEmbeddedMarker(retainedByPath[Path.GetFullPath(provisionerPath)], machineBinding);
                RequireEmbeddedMarker(retainedByPath[Path.GetFullPath(shellPath)], machineBinding);

                List<object> bindings = new List<object>();
                bindings.Add(new Dictionary<string, object> { { "kind", "machine" }, { "id", "machine" }, { "binding", machineBinding } });
                string appsRoot = Path.Combine(root, "apps");
                DirectoryInfo[] appDirectories = new DirectoryInfo(appsRoot).GetDirectories();
                if (appDirectories.Length < 1 || appDirectories.Length > 64) throw new InvalidDataException("Arcane publisher-attestation stage has an invalid application count.");
                Array.Sort(appDirectories, delegate(DirectoryInfo left, DirectoryInfo right) { return StringComparer.Ordinal.Compare(left.Name, right.Name); });
                foreach (DirectoryInfo appDirectory in appDirectories)
                {
                    string id = appDirectory.Name;
                    if (!AppIdPattern.IsMatch(id) || id == "shell" || id == "provisioner") throw new InvalidDataException("Arcane publisher-attestation stage has an invalid application identity.");
                    string contentPath = Path.Combine(appDirectory.FullName, TargetManifestName);
                    FileStream contentFile;
                    if (!retainedByPath.TryGetValue(Path.GetFullPath(contentPath), out contentFile)) throw new InvalidDataException("Arcane publisher-attestation stage did not retain an application content manifest.");
                    string contentHash = HashStream(contentFile);
                    Dictionary<string, object> content = ParseObject(ReadRetainedFile(contentFile, 64 * 1024 * 1024, id + " content manifest"), id + " content manifest");
                    VerifyTargetManifest(appDirectory.FullName, content, id, version);
                    string targetBinding = "ARCANE-TARGET-BINDING|1|" + id + "|" + contentHash;
                    string wrapperPath = Path.Combine(appDirectory.FullName, "ArcaneApp-" + id + ".exe");
                    FileStream wrapper;
                    if (!retainedByPath.TryGetValue(Path.GetFullPath(wrapperPath), out wrapper)) throw new InvalidDataException("Arcane publisher-attestation stage did not retain an application wrapper.");
                    RequireEmbeddedMarker(wrapper, targetBinding);
                    bindings.Add(new Dictionary<string, object> { { "kind", "app" }, { "id", id }, { "binding", targetBinding } });
                }

                string signer = VerifyStrictPublisherSet(executables);
                if (!String.Equals(machineBinding, probeSecurity.ContentBinding, StringComparison.Ordinal)
                    || !String.Equals(signer, probeSecurity.SignerThumbprint, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Arcane publisher-attestation stage does not match the strictly verified probe release binding and signer.");
                string trustSource = ResolvePublisherContinuity(signer, true);
                Dictionary<string, object> attestation = new Dictionary<string, object>
                {
                    { "schemaVersion", 1 },
                    { "verification", "wintrust-online-chain-exclude-root-timestamp-v1" },
                    { "signerThumbprint", signer },
                    { "verifiedAt", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) },
                    { "trustSource", trustSource },
                    { "bindings", bindings.ToArray() }
                };
                return new JavaScriptSerializer().Serialize(attestation);
            }
            finally
            {
                foreach (FileStream file in retained) try { file.Dispose(); } catch { }
                foreach (RetainedDirectoryHandle directory in retainedDirectories) try { directory.Dispose(); } catch { }
            }
        }

        private static string VerifyStrictPublisherSet(List<string> executables)
        {
            if (executables == null || executables.Count == 0) throw new InvalidDataException("Arcane publisher-attestation stage contains no executables.");
            HashSet<string> unique = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string signer = null;
            foreach (string executable in executables)
            {
                string fullPath = Path.GetFullPath(executable);
                if (!unique.Add(fullPath)) continue;
                SignatureEvidence evidence = Authenticode.Verify(fullPath, AuthenticodePurpose.StrictOnline);
                if (evidence.Status != SignatureStatus.Valid || !evidence.TimestampVerified || String.IsNullOrWhiteSpace(evidence.SignerThumbprint))
                    throw new InvalidDataException("Arcane strict publisher-attestation verification rejected " + Path.GetFileName(fullPath) + ": " + evidence.Details);
                if (signer == null) signer = NormalizePublisherThumbprint(evidence.SignerThumbprint, "strict publisher signer");
                else if (!String.Equals(signer, evidence.SignerThumbprint, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Arcane publisher-attestation stage contains executables from different publishers.");
            }
            if (signer == null) throw new InvalidDataException("Arcane publisher-attestation stage has no verified signer.");
            return signer;
        }

        private static void RetainDirectoryTree(
            string root,
            string directory,
            Dictionary<string, RetainedDirectoryHandle> opened,
            List<RetainedDirectoryHandle> retained)
        {
            RetainDirectoryTree(root, directory, opened, retained, null);
        }

        private static void RetainDirectoryTree(
            string root,
            string directory,
            Dictionary<string, RetainedDirectoryHandle> opened,
            List<RetainedDirectoryHandle> retained,
            StartupBackdrop startupBackdrop)
        {
            int openedCount = 0;
            RetainDirectoryTreeCore(root, directory, opened, retained, startupBackdrop, ref openedCount);
        }

        private static void RetainDirectoryTreeCore(
            string root,
            string directory,
            Dictionary<string, RetainedDirectoryHandle> opened,
            List<RetainedDirectoryHandle> retained,
            StartupBackdrop startupBackdrop,
            ref int openedCount)
        {
            RetainDirectory(directory, opened, retained);
            openedCount++;
            if (startupBackdrop != null) startupBackdrop.ReportDirectoryProgress(openedCount);
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
                RetainDirectoryTreeCore(root, child.FullName, opened, retained, startupBackdrop, ref openedCount);
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
                if (length > 32767) throw new InvalidDataException("Arcane retained directory path exceeds the Microsoft NT maximum.");
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
            List<FileStream> retained,
            StartupBackdrop startupBackdrop = null)
        {
            long totalBytes = 0;
            foreach (ManifestFile entry in files) totalBytes += entry.Size;
            for (int index = 0; index < files.Count; index++)
            {
                ManifestFile entry = files[index];
                string path = Path.Combine(root, entry.RelativePath.Replace('/', Path.DirectorySeparatorChar));
                FileStream file = RetainFile(path, opened, retained);
                if (file.Length != entry.Size)
                    throw new InvalidDataException("Arcane release file changed size during verification: " + entry.RelativePath + ".");
                if (startupBackdrop != null) startupBackdrop.ReportFileHandleProgress(index + 1, files.Count);
            }
            foreach (string host in excludedHosts) RetainFile(host, opened, retained);
            if (startupBackdrop != null) startupBackdrop.CompleteStage("handles", files.Count.ToString(CultureInfo.InvariantCulture)
                + " manifest file handles and protected native-host handles retained.");

            long verifiedBytes = 0;
            if (startupBackdrop != null) startupBackdrop.BeginHashVerification(files.Count, totalBytes);
            for (int index = 0; index < files.Count; index++)
            {
                ManifestFile entry = files[index];
                string path = Path.Combine(root, entry.RelativePath.Replace('/', Path.DirectorySeparatorChar));
                FileStream file = opened[Path.GetFullPath(path)];
                if (file.Length != entry.Size || !FixedTimeEquals(HashStream(file), entry.Sha256))
                    throw new InvalidDataException("Arcane release file changed during verification: " + entry.RelativePath + ".");
                verifiedBytes += entry.Size;
                if (startupBackdrop != null) startupBackdrop.ReportHashProgress(index + 1, files.Count, verifiedBytes, totalBytes);
            }
            if (startupBackdrop != null) startupBackdrop.CompleteHashVerification(files.Count, totalBytes);
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
            RequireInventoryFile(files, "bin/ArcaneOllamaService.exe");
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
                "bin/ArcaneOllamaService.exe",
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

        private static bool IsCanonicalInstalledRelease(string root)
        {
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (String.IsNullOrWhiteSpace(programFiles)) return false;
            string machineRoot = Path.GetFullPath(Path.Combine(programFiles, "Arcane OS")).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
#if ARCANE_TARGET_APP
            string expected = Path.Combine(machineRoot, "apps", Program.AppMode);
#else
            string expected = machineRoot;
#endif
            expected = Path.GetFullPath(expected).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return String.Equals(root, expected, StringComparison.OrdinalIgnoreCase);
        }

        private static ExecutableSecurityResult VerifyExecutableSignatures(
            List<string> executables,
            bool allowUnsigned,
            string publisherMarker,
            string contentBinding,
            string releaseRoot,
            bool canonicalInstalled,
            Dictionary<string, FileStream> retainedByPath,
            List<FileStream> retained,
            StartupBackdrop startupBackdrop = null)
        {
            if (executables == null || executables.Count == 0) throw new InvalidDataException("Arcane release contains no native executables to authenticate.");
            HashSet<string> unique = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string signer = null;
            bool sawValid = false;
            bool sawUnsigned = false;
            bool sawUnavailableRevocation = false;
            bool offlineInstalledPolicy = canonicalInstalled && Program.AppMode != "provisioner";
            HashSet<string> executablePaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string executable in executables) executablePaths.Add(Path.GetFullPath(executable));
            int executableTotal = executablePaths.Count;
            int executableIndex = 0;
            if (startupBackdrop != null) startupBackdrop.BeginAuthenticodeVerification(executableTotal);
            foreach (string executable in executables)
            {
                string fullPath = Path.GetFullPath(executable);
                if (!unique.Add(fullPath)) continue;
                executableIndex++;
                if (startupBackdrop != null) startupBackdrop.ReportAuthenticodeProgress(executableIndex, executableTotal, Path.GetFileName(fullPath), false);
                AssertRegularFile(fullPath, "Arcane executable");
                SignatureEvidence evidence;
                if (offlineInstalledPolicy)
                {
                    evidence = Authenticode.Verify(fullPath, AuthenticodePurpose.OfflineBaseline);
                    if (evidence.Status == SignatureStatus.Valid)
                    {
                        SignatureEvidence revocation = Authenticode.Verify(fullPath, AuthenticodePurpose.OfflineRevocation);
                        if (revocation.Status == SignatureStatus.Revoked)
                            throw new InvalidDataException("Arcane rejected an explicitly revoked Authenticode signature on " + Path.GetFileName(fullPath) + ".");
                        if (revocation.Status == SignatureStatus.RevocationUnavailable || revocation.Status == SignatureStatus.TimedOut)
                            sawUnavailableRevocation = true;
                        else if (revocation.Status != SignatureStatus.Valid)
                            throw new InvalidDataException("Arcane rejected an invalid cache-only Authenticode result on " + Path.GetFileName(fullPath) + ": " + revocation.Details);
                    }
                }
                else evidence = Authenticode.Verify(fullPath, AuthenticodePurpose.StrictOnline);

                if (evidence.Status == SignatureStatus.Revoked)
                    throw new InvalidDataException("Arcane rejected an explicitly revoked Authenticode signature on " + Path.GetFileName(fullPath) + ".");
                if (evidence.Status == SignatureStatus.RevocationUnavailable)
                    throw new InvalidDataException("Arcane could not complete strict online revocation verification for " + Path.GetFileName(fullPath) + ": " + evidence.Details);
                if (evidence.Status == SignatureStatus.TimedOut)
                    throw new InvalidDataException("Arcane timed out while authenticating " + Path.GetFileName(fullPath) + ": " + evidence.Details);
                if (evidence.Status == SignatureStatus.Invalid)
                    throw new InvalidDataException("Arcane rejected an invalid Authenticode signature on " + Path.GetFileName(fullPath) + ": " + evidence.Details);
                if (evidence.Status == SignatureStatus.NotSigned)
                {
                    sawUnsigned = true;
                    if (startupBackdrop != null) startupBackdrop.ReportAuthenticodeProgress(executableIndex, executableTotal, Path.GetFileName(fullPath), true);
                    continue;
                }
                sawValid = true;
                if (!evidence.TimestampVerified)
                    throw new InvalidDataException("Arcane requires a verified Authenticode timestamp on " + Path.GetFileName(fullPath) + ".");
                if (String.IsNullOrWhiteSpace(evidence.SignerThumbprint)) throw new InvalidDataException("Arcane could not identify the trusted signer for " + Path.GetFileName(fullPath) + ".");
                if (signer == null) signer = evidence.SignerThumbprint;
                else if (!String.Equals(signer, evidence.SignerThumbprint, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Arcane rejected a release containing executables from different publishers.");
                if (startupBackdrop != null) startupBackdrop.ReportAuthenticodeProgress(executableIndex, executableTotal, Path.GetFileName(fullPath), true);
            }
            if (sawValid && sawUnsigned) throw new InvalidDataException("Arcane rejected a release that mixes signed and unsigned executables.");
            if (sawValid)
            {
                string expectedPrefix = PublisherMarkerPrefix;
                if (String.IsNullOrWhiteSpace(publisherMarker) || !publisherMarker.StartsWith(expectedPrefix, StringComparison.Ordinal))
                    throw new InvalidDataException("Arcane rejected a missing native publisher binding.");
                string expectedSigner = publisherMarker.Substring(expectedPrefix.Length);
                if (!Regex.IsMatch(expectedSigner, "^[A-Fa-f0-9]{40,128}$", RegexOptions.CultureInvariant)
                    || !String.Equals(expectedSigner, signer, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Arcane rejected a release that is not signed by its configured publisher certificate.");
                string publisherTrustSource = ResolvePublisherContinuity(signer, false);
                string verifiedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
                string revocationStatus = offlineInstalledPolicy ? "cache-good" : "online-good";
                if (sawUnavailableRevocation)
                {
                    verifiedAt = ValidatePublisherAttestation(releaseRoot, contentBinding, signer, retainedByPath, retained);
                    revocationStatus = "attested-degraded";
                }
                if (startupBackdrop != null) startupBackdrop.CompleteAuthenticodeVerification(executableTotal);
                return new ExecutableSecurityResult("publisher-verified", signer, verifiedAt, revocationStatus, publisherTrustSource, true);
            }
            if (sawUnsigned && allowUnsigned)
            {
                if (!String.Equals(publisherMarker, UnsignedPublisherMarker, StringComparison.Ordinal))
                    throw new InvalidDataException("Arcane rejected an unsigned release without its explicit local-test publisher binding.");
                AssertUnsignedLocalReleaseAllowed();
                if (startupBackdrop != null) startupBackdrop.CompleteAuthenticodeVerification(executableTotal);
                return new ExecutableSecurityResult("unsigned-local-test", null, null, null, null, false);
            }
            throw new InvalidDataException("Arcane requires a publisher-signed release. The unsigned local override must be passed explicitly for controlled testing.");
        }

        private static string ValidatePublisherAttestation(
            string releaseRoot,
            string contentBinding,
            string signerThumbprint,
            Dictionary<string, FileStream> retainedByPath,
            List<FileStream> retained)
        {
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string machineRoot = Path.GetFullPath(Path.Combine(programFiles, "Arcane OS")).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
#if ARCANE_TARGET_APP
            string expectedRoot = Path.GetFullPath(Path.Combine(machineRoot, "apps", Program.AppMode)).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string expectedKind = "app";
            string expectedId = Program.AppMode;
#else
            string expectedRoot = machineRoot;
            string expectedKind = "machine";
            string expectedId = "machine";
#endif
            if (!String.Equals(releaseRoot, expectedRoot, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Arcane refuses degraded revocation verification outside its canonical installed location.");
            AssertRegularDirectory(machineRoot, "installed machine root");
            AssertAdminProtectedTree(machineRoot);
            string manifestPath = Path.Combine(machineRoot, "arcane-install.json");
            AssertRegularFile(manifestPath, "publisher attestation");
            AssertAdminProtected(File.GetAccessControl(manifestPath, AccessControlSections.Owner | AccessControlSections.Access), "publisher attestation");
            FileStream manifestFile = RetainFile(manifestPath, retainedByPath, retained);
            Dictionary<string, object> install = ParseObject(ReadRetainedFile(manifestFile, 1024 * 1024, "publisher attestation"), "publisher attestation");
            Dictionary<string, object> attestation = RequireObject(install, "publisherAttestation", "install manifest");
            RequireOnlyKeys(attestation, "publisher attestation", "schemaVersion", "verification", "signerThumbprint", "verifiedAt", "trustSource", "bindings");
            RequireInteger(attestation, "schemaVersion", 1, "publisher attestation");
            RequireString(attestation, "verification", "wintrust-online-chain-exclude-root-timestamp-v1", "publisher attestation");
            string attestedSigner = RequireNonEmptyString(attestation, "signerThumbprint", "publisher attestation");
            if (!Regex.IsMatch(attestedSigner, "^[A-Fa-f0-9]{40,128}$", RegexOptions.CultureInvariant)
                || !String.Equals(attestedSigner, signerThumbprint, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Arcane publisher attestation signer does not match the verified release signer.");
            string verifiedAt = RequireNonEmptyString(attestation, "verifiedAt", "publisher attestation");
            string trustSource = RequireNonEmptyString(attestation, "trustSource", "publisher attestation");
            if (trustSource != "administrator-policy" && trustSource != "administrator-policy-rotation"
                && trustSource != "installed-continuity" && trustSource != "uac-approved-tofu")
                throw new InvalidDataException("Arcane publisher attestation trust source is invalid.");
            ValidateDegradedVerificationTime(verifiedAt, DateTimeOffset.UtcNow);

            object rawBindings;
            if (!attestation.TryGetValue("bindings", out rawBindings) || !(rawBindings is object[]))
                throw new InvalidDataException("Arcane publisher attestation bindings must be an array.");
            object[] bindings = (object[])rawBindings;
            if (bindings.Length < 1 || bindings.Length > 128) throw new InvalidDataException("Arcane publisher attestation has an invalid binding count.");
            HashSet<string> identities = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            bool matched = false;
            foreach (object rawBinding in bindings)
            {
                Dictionary<string, object> binding = rawBinding as Dictionary<string, object>;
                if (binding == null) throw new InvalidDataException("Arcane publisher attestation contains a non-object binding.");
                RequireOnlyKeys(binding, "publisher attestation binding", "kind", "id", "binding");
                string kind = RequireNonEmptyString(binding, "kind", "publisher attestation binding");
                string id = RequireNonEmptyString(binding, "id", "publisher attestation binding");
                string value = RequireNonEmptyString(binding, "binding", "publisher attestation binding");
                if (!identities.Add(kind + "|" + id)) throw new InvalidDataException("Arcane publisher attestation contains a duplicate binding identity.");
                string[] parts = value.Split('|');
                bool validMachine = kind == "machine" && id == "machine" && parts.Length == 4 && parts[0] == "ARCANE-MACHINE-BINDING" && parts[1] == "1" && HashPattern.IsMatch(parts[3]);
                bool validApp = kind == "app" && AppIdPattern.IsMatch(id) && parts.Length == 4 && parts[0] == "ARCANE-TARGET-BINDING" && parts[1] == "1" && parts[2] == id && HashPattern.IsMatch(parts[3]);
                if (!validMachine && !validApp) throw new InvalidDataException("Arcane publisher attestation contains a malformed content binding.");
                if (kind == expectedKind && id == expectedId)
                {
                    if (!String.Equals(value, contentBinding, StringComparison.Ordinal)) throw new InvalidDataException("Arcane publisher attestation does not match the compiled content binding.");
                    matched = true;
                }
            }
            if (!matched) throw new InvalidDataException("Arcane publisher attestation does not cover this installed content binding.");
            return verifiedAt;
        }

        private static string ResolvePublisherContinuity(string signerThumbprint, bool administratorApprovedTofu)
        {
            string signer = NormalizePublisherThumbprint(signerThumbprint, "verified publisher signer");
            PublisherPolicy policy = ReadAdministratorPublisherPolicy();
            string installedSigner = ReadInstalledPublisherPin();
            WindowsPrincipal principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
            return EvaluatePublisherContinuityPolicy(
                signer,
                installedSigner,
                policy == null ? null : policy.CurrentSigner,
                policy == null ? null : policy.PreviousSigner,
                policy == null ? 1 : policy.Version,
                administratorApprovedTofu,
                principal.IsInRole(WindowsBuiltInRole.Administrator));
        }

        private static PublisherPolicy ReadAdministratorPublisherPolicy()
        {
            using (RegistryKey machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (RegistryKey key = machine.OpenSubKey(
                @"SOFTWARE\Arcane OS\Security",
                RegistryKeyPermissionCheck.ReadSubTree,
                RegistryRights.ReadKey | RegistryRights.ReadPermissions))
            {
                if (key == null) return null;
                AssertAdminControlledRegistry(key.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access), "administrator publisher policy");
                HashSet<string> names = new HashSet<string>(key.GetValueNames(), StringComparer.OrdinalIgnoreCase);
                foreach (string name in names)
                    if (name != "PublisherThumbprint" && name != "PreviousPublisherThumbprint" && name != "PublisherPolicyVersion")
                        throw new InvalidDataException("Arcane administrator publisher policy contains an unknown value.");
                bool hasCurrent = names.Contains("PublisherThumbprint");
                bool hasPrevious = names.Contains("PreviousPublisherThumbprint");
                bool hasVersion = names.Contains("PublisherPolicyVersion");
                if (!hasCurrent)
                {
                    if (hasPrevious || hasVersion) throw new InvalidDataException("Arcane administrator publisher rotation policy has no new publisher thumbprint.");
                    return null;
                }
                if (key.GetValueKind("PublisherThumbprint") != RegistryValueKind.String)
                    throw new InvalidDataException("Arcane administrator publisher policy value type is invalid.");
                if (hasPrevious && key.GetValueKind("PreviousPublisherThumbprint") != RegistryValueKind.String)
                    throw new InvalidDataException("Arcane administrator previous publisher policy value type is invalid.");
                if (hasVersion && key.GetValueKind("PublisherPolicyVersion") != RegistryValueKind.DWord)
                    throw new InvalidDataException("Arcane administrator publisher policy version type is invalid.");
                if (hasPrevious && !hasVersion)
                    throw new InvalidDataException("Arcane administrator publisher rotation policy has no explicit version.");
                string current = key.GetValue("PublisherThumbprint", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
                string previous = hasPrevious ? key.GetValue("PreviousPublisherThumbprint", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string : null;
                int version = hasVersion ? (int)key.GetValue("PublisherPolicyVersion", null, RegistryValueOptions.DoNotExpandEnvironmentNames) : 1;
                if (version != 1) throw new InvalidDataException("Arcane administrator publisher policy version is unsupported.");
                return new PublisherPolicy(
                    NormalizePublisherThumbprint(current, "administrator publisher policy"),
                    previous == null ? null : NormalizePublisherThumbprint(previous, "administrator previous publisher policy"),
                    version);
            }
        }

        private static void AssertUnsignedLocalReleaseAllowed()
        {
            if (ReadAdministratorPublisherPolicy() != null)
                throw new InvalidDataException("Arcane rejected an unsigned local release because an administrator publisher policy is installed.");
            if (ReadInstalledPublisherPin() != null)
                throw new InvalidDataException("Arcane rejected an unsigned local release because signed installed publisher continuity exists.");
        }

        internal static void AssertAdminControlledRegistry(RegistrySecurity security, string label)
        {
            if (security == null) throw new ArgumentNullException("security");
            SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            SecurityIdentifier administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            SecurityIdentifier creatorOwner = new SecurityIdentifier(WellKnownSidType.CreatorOwnerSid, null);
            SecurityIdentifier owner = security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            RawSecurityDescriptor descriptor = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
            if (owner == null || (!owner.Equals(system) && !owner.Equals(administrators)) || descriptor.DiscretionaryAcl == null)
                throw new InvalidDataException("Arcane " + label + " registry ownership or DACL is invalid.");
            RegistryRights unsafeRights = RegistryRights.SetValue | RegistryRights.CreateSubKey
                | RegistryRights.CreateLink | RegistryRights.Delete | RegistryRights.ChangePermissions | RegistryRights.TakeOwnership;
            AuthorizationRuleCollection rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
            foreach (RegistryAccessRule rule in rules)
            {
                SecurityIdentifier identity = rule.IdentityReference as SecurityIdentifier;
                bool trustedCreatorOwnerInheritance = identity != null && identity.Equals(creatorOwner)
                    && (rule.PropagationFlags & PropagationFlags.InheritOnly) != 0;
                if (identity != null && rule.AccessControlType == AccessControlType.Allow
                    && (rule.RegistryRights & unsafeRights) != 0 && !identity.Equals(system)
                    && !identity.Equals(administrators) && !trustedCreatorOwnerInheritance)
                    throw new InvalidDataException("Arcane " + label + " registry grants write access to an untrusted identity.");
            }
        }

        internal static string EvaluatePublisherContinuityPolicy(
            string signer,
            string installedSigner,
            string policySigner,
            string previousPolicySigner,
            int policyVersion,
            bool administratorApprovedTofu,
            bool isAdministrator)
        {
            bool rotation = false;
            if (policySigner != null && installedSigner != null && !String.Equals(policySigner, installedSigner, StringComparison.OrdinalIgnoreCase))
            {
                if (policyVersion != 1 || previousPolicySigner == null
                    || !String.Equals(previousPolicySigner, installedSigner, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Arcane administrator publisher policy conflicts with the protected installed pin and has no valid rotation authorization.");
                rotation = true;
            }
            else if (policySigner != null && previousPolicySigner != null && installedSigner != null
                && !String.Equals(previousPolicySigner, installedSigner, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Arcane administrator publisher rotation predecessor does not match the protected installed pin.");
            string expected = policySigner ?? installedSigner;
            if (expected != null)
            {
                if (!String.Equals(expected, signer, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Arcane rejected a publisher that does not match its protected continuity policy.");
                return rotation ? "administrator-policy-rotation" : policySigner != null ? "administrator-policy" : "installed-continuity";
            }
            if (!administratorApprovedTofu) return "fresh-unpinned";
            if (!isAdministrator)
                throw new InvalidDataException("Arcane can establish a first-use publisher pin only inside an administrator-approved installation transaction.");
            return "uac-approved-tofu";
        }

        private sealed class PublisherPolicy
        {
            internal string CurrentSigner { get; private set; }
            internal string PreviousSigner { get; private set; }
            internal int Version { get; private set; }
            internal PublisherPolicy(string currentSigner, string previousSigner, int version)
            {
                CurrentSigner = currentSigner;
                PreviousSigner = previousSigner;
                Version = version;
            }
        }

        private static string ReadInstalledPublisherPin()
        {
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (String.IsNullOrWhiteSpace(programFiles)) return null;
            string machineRoot = Path.GetFullPath(Path.Combine(programFiles, "Arcane OS"));
            string manifestPath = Path.Combine(machineRoot, "arcane-install.json");
            try
            {
                try
                {
                    File.GetAttributes(machineRoot);
                }
                catch (DirectoryNotFoundException) { return null; }
                catch (FileNotFoundException) { return null; }

                try
                {
                    File.GetAttributes(manifestPath);
                }
                catch (DirectoryNotFoundException)
                {
                    throw new InvalidDataException("Arcane found an installed machine root without its continuity manifest.");
                }
                catch (FileNotFoundException)
                {
                    throw new InvalidDataException("Arcane found an installed machine root without its continuity manifest.");
                }

                AssertRegularDirectory(machineRoot, "installed machine root");
                AssertRegularFile(manifestPath, "installed publisher continuity manifest");
                byte[] data;
                using (FileStream stream = new FileStream(manifestPath, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    if (stream.Length < 1 || stream.Length > 1024 * 1024) throw new InvalidDataException("Arcane installed publisher continuity manifest has an invalid size.");
                    data = new byte[(int)stream.Length];
                    int offset = 0;
                    while (offset < data.Length)
                    {
                        int read = stream.Read(data, offset, data.Length - offset);
                        if (read == 0) throw new EndOfStreamException("Arcane installed publisher continuity manifest changed while it was retained.");
                        offset += read;
                    }
                }
                Dictionary<string, object> install = ParseObject(data, "installed publisher continuity manifest");
                object rawAttestation;
                if (!install.TryGetValue("publisherAttestation", out rawAttestation))
                {
                    bool preIntegrityLegacy = !install.ContainsKey("integrity") && !install.ContainsKey("securityMode");
                    List<string> installedExecutables = preIntegrityLegacy
                        ? InspectLegacyAdminControlledTree(machineRoot)
                        : InspectAdminProtectedTree(machineRoot);
                    return ReadLegacyInstalledPublisherPin(machineRoot, installedExecutables);
                }
                InspectAdminProtectedTree(machineRoot);
                Dictionary<string, object> attestation = rawAttestation as Dictionary<string, object>;
                if (attestation == null) throw new InvalidDataException("Arcane installed publisher continuity attestation is malformed.");
                return NormalizePublisherThumbprint(RequireNonEmptyString(attestation, "signerThumbprint", "installed publisher continuity attestation"), "installed publisher continuity pin");
            }
            catch (UnauthorizedAccessException error)
            {
                throw new InstalledTrustStateAccessException(manifestPath, error);
            }
            catch (System.Security.SecurityException error)
            {
                throw new InstalledTrustStateAccessException(manifestPath, error);
            }
        }

        private static string ReadLegacyInstalledPublisherPin(string machineRoot, List<string> executables)
        {
            if (executables == null || executables.Count == 0) throw new InvalidDataException("Arcane legacy installation contains no executable continuity set.");
            string provisioner = Path.GetFullPath(Path.Combine(machineRoot, "bin", "ArcaneProvisioner.exe"));
            string shell = Path.GetFullPath(Path.Combine(machineRoot, "bin", "ArcaneShell.exe"));
            HashSet<string> executableSet = new HashSet<string>(executables, StringComparer.OrdinalIgnoreCase);
            if (!executableSet.Contains(provisioner) || !executableSet.Contains(shell))
                throw new InvalidDataException("Arcane legacy installation is missing its canonical native hosts.");
            SignatureStatus[] statuses = new SignatureStatus[executables.Count];
            string[] signers = new string[executables.Count];
            bool[] timestamps = new bool[executables.Count];
            for (int index = 0; index < executables.Count; index++)
            {
                string executable = executables[index];
                AssertRegularFile(executable, "legacy installed executable");
                SignatureEvidence evidence = Authenticode.Verify(executable, AuthenticodePurpose.OfflineBaseline);
                statuses[index] = evidence.Status;
                signers[index] = evidence.SignerThumbprint;
                timestamps[index] = evidence.TimestampVerified;
            }
            return EvaluateLegacyInstalledPublisherEvidence(statuses, signers, timestamps);
        }

        internal static string EvaluateLegacyInstalledPublisherEvidence(SignatureStatus[] statuses, string[] signerThumbprints, bool[] timestampVerified)
        {
            if (statuses == null || signerThumbprints == null || timestampVerified == null || statuses.Length == 0
                || statuses.Length != signerThumbprints.Length || statuses.Length != timestampVerified.Length)
                throw new InvalidDataException("Arcane legacy publisher evidence has inconsistent dimensions.");
            bool sawValid = false;
            bool sawUnsigned = false;
            string signer = null;
            for (int index = 0; index < statuses.Length; index++)
            {
                if (statuses[index] == SignatureStatus.Valid)
                {
                    if (!timestampVerified[index]) throw new InvalidDataException("Arcane legacy publisher evidence contains an untimestamped signature.");
                    string current = NormalizePublisherThumbprint(signerThumbprints[index], "legacy installed publisher signer");
                    if (signer == null) signer = current;
                    else if (!String.Equals(signer, current, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Arcane legacy installation contains executables from different publishers.");
                    sawValid = true;
                    continue;
                }
                if (statuses[index] == SignatureStatus.NotSigned)
                {
                    if (!String.IsNullOrEmpty(signerThumbprints[index]) || timestampVerified[index])
                        throw new InvalidDataException("Arcane legacy unsigned evidence contains unexpected signer material.");
                    sawUnsigned = true;
                    continue;
                }
                throw new InvalidDataException("Arcane could not establish legacy installed publisher continuity from " + statuses[index].ToString() + " evidence.");
            }
            if (sawValid && sawUnsigned) throw new InvalidDataException("Arcane legacy installation mixes signed and unsigned executables.");
            return sawValid ? signer : null;
        }

        private static string NormalizePublisherThumbprint(string value, string label)
        {
            string normalized = String.IsNullOrWhiteSpace(value) ? "" : Regex.Replace(value, "\\s", "").ToUpperInvariant();
            if (!Regex.IsMatch(normalized, "^[A-F0-9]{40,128}$", RegexOptions.CultureInvariant))
                throw new InvalidDataException("Arcane " + label + " is invalid.");
            return normalized;
        }

        private static void AssertAdminProtected(FileSystemSecurity security, string label)
        {
            SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            SecurityIdentifier administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            SecurityIdentifier owner = security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            if (owner == null || (!owner.Equals(system) && !owner.Equals(administrators)) || !security.AreAccessRulesProtected)
                throw new InvalidDataException("Arcane " + label + " ownership or ACL protection is invalid.");
            FileSystemRights unsafeRights = FileSystemRights.WriteData | FileSystemRights.AppendData
                | FileSystemRights.WriteExtendedAttributes | FileSystemRights.WriteAttributes | FileSystemRights.Delete
                | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
            AuthorizationRuleCollection rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
            foreach (FileSystemAccessRule rule in rules)
            {
                SecurityIdentifier identity = rule.IdentityReference as SecurityIdentifier;
                if (identity != null && rule.AccessControlType == AccessControlType.Allow
                    && (rule.FileSystemRights & unsafeRights) != 0 && !identity.Equals(system) && !identity.Equals(administrators))
                    throw new InvalidDataException("Arcane " + label + " grants write access to an untrusted identity.");
            }
        }

        private static void AssertAdminProtectedTree(string root)
        {
            InspectAdminProtectedTree(root);
        }

        private static List<string> InspectAdminProtectedTree(string root)
        {
            return InspectInstalledTree(root, true);
        }

        private static List<string> InspectLegacyAdminControlledTree(string root)
        {
            return InspectInstalledTree(root, false);
        }

        private static void AssertLegacyAdminControlled(FileSystemSecurity security, string label)
        {
            if (security == null) throw new ArgumentNullException("security");
            SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            SecurityIdentifier administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            SecurityIdentifier creatorOwner = new SecurityIdentifier(WellKnownSidType.CreatorOwnerSid, null);
            SecurityIdentifier trustedInstaller = new SecurityIdentifier("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");
            SecurityIdentifier owner = security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            RawSecurityDescriptor descriptor = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
            if (owner == null || (!owner.Equals(system) && !owner.Equals(administrators) && !owner.Equals(trustedInstaller))
                || descriptor.DiscretionaryAcl == null)
                throw new InvalidDataException("Arcane " + label + " legacy ownership or DACL is invalid.");
            FileSystemRights unsafeRights = FileSystemRights.WriteData | FileSystemRights.AppendData
                | FileSystemRights.WriteExtendedAttributes | FileSystemRights.WriteAttributes | FileSystemRights.Delete
                | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
            AuthorizationRuleCollection rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
            foreach (FileSystemAccessRule rule in rules)
            {
                SecurityIdentifier identity = rule.IdentityReference as SecurityIdentifier;
                bool trustedCreatorOwnerInheritance = identity != null && identity.Equals(creatorOwner)
                    && (rule.PropagationFlags & PropagationFlags.InheritOnly) != 0;
                if (identity != null && rule.AccessControlType == AccessControlType.Allow
                    && (rule.FileSystemRights & unsafeRights) != 0 && !identity.Equals(system)
                    && !identity.Equals(administrators) && !identity.Equals(trustedInstaller)
                    && !trustedCreatorOwnerInheritance)
                    throw new InvalidDataException("Arcane " + label + " legacy ACL grants mutation rights to an untrusted identity.");
            }
        }

        private static List<string> InspectInstalledTree(string root, bool requireProtected)
        {
            Stack<FileSystemInfo> pending = new Stack<FileSystemInfo>();
            pending.Push(new DirectoryInfo(root));
            List<string> executables = new List<string>();
            int count = 0;
            while (pending.Count > 0)
            {
                FileSystemInfo item = pending.Pop();
                if (++count > 50000) throw new InvalidDataException("Arcane installed protection tree exceeds its safety bound.");
                if ((item.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Arcane installed protection tree contains a reparse point.");
                DirectoryInfo directory = item as DirectoryInfo;
                FileInfo file = item as FileInfo;
                if (directory != null)
                {
                    DirectorySecurity security = Directory.GetAccessControl(directory.FullName, AccessControlSections.Owner | AccessControlSections.Access);
                    if (requireProtected) AssertAdminProtected(security, "installed directory");
                    else AssertLegacyAdminControlled(security, "installed directory");
                    foreach (FileSystemInfo child in directory.GetFileSystemInfos()) pending.Push(child);
                }
                else if (file != null)
                {
                    FileSecurity security = File.GetAccessControl(file.FullName, AccessControlSections.Owner | AccessControlSections.Access);
                    if (requireProtected) AssertAdminProtected(security, "installed file");
                    else AssertLegacyAdminControlled(security, "installed file");
                    if (file.Name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) executables.Add(Path.GetFullPath(file.FullName));
                }
                else throw new InvalidDataException("Arcane installed protection tree contains an unsupported entry.");
            }
            executables.Sort(StringComparer.OrdinalIgnoreCase);
            return executables;
        }

        private sealed class ExecutableSecurityResult
        {
            internal string SecurityMode { get; private set; }
            internal string SignerThumbprint { get; private set; }
            internal string VerifiedAtUtc { get; private set; }
            internal string RevocationStatus { get; private set; }
            internal string PublisherTrustSource { get; private set; }
            internal bool TimestampVerified { get; private set; }
            internal ExecutableSecurityResult(string mode, string signer, string verifiedAt, string revocationStatus, string publisherTrustSource, bool timestampVerified)
            {
                SecurityMode = mode;
                SignerThumbprint = signer;
                VerifiedAtUtc = verifiedAt;
                RevocationStatus = revocationStatus;
                PublisherTrustSource = publisherTrustSource;
                TimestampVerified = timestampVerified;
            }
        }

        private static string ReadOwnMetadataMarker(string metadataKey, string expectedPrefix, string label)
        {
            string marker = null;
            object[] attributes = Assembly.GetExecutingAssembly().GetCustomAttributes(typeof(AssemblyMetadataAttribute), false);
            foreach (AssemblyMetadataAttribute attribute in attributes)
            {
                if (!String.Equals(attribute.Key, metadataKey, StringComparison.Ordinal)) continue;
                if (marker != null) throw new InvalidDataException("Arcane native host contains a duplicate " + label + ".");
                marker = attribute.Value;
            }
            if (String.IsNullOrWhiteSpace(marker) || !marker.StartsWith(expectedPrefix, StringComparison.Ordinal)) throw new InvalidDataException("Arcane native host is missing its release " + label + ".");
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

    internal static class AuthenticodeProbe
    {
        private const string ProbeArgument = "--arcane-authenticode-probe";
        private const int MaximumProbeOutput = 64 * 1024;
        private static readonly object ProbeLock = new object();

        internal static bool TryRun(string[] args)
        {
            if (args == null || args.Length == 0 || !String.Equals(args[0], ProbeArgument, StringComparison.Ordinal)) return false;
            try
            {
                if (args.Length != 3 || args[1].Length > 32 || args[2].Length > 48 * 1024)
                    throw new ArgumentException("Arcane rejected malformed Authenticode-probe arguments.");
                AuthenticodePurpose purpose = (AuthenticodePurpose)Enum.Parse(typeof(AuthenticodePurpose), args[1], false);
                if (!Enum.IsDefined(typeof(AuthenticodePurpose), purpose)) throw new ArgumentException("Arcane rejected an unknown Authenticode-probe purpose.");
                byte[] encodedPath = Convert.FromBase64String(args[2]);
                if (encodedPath.Length < 1 || encodedPath.Length > 32767 * 4) throw new ArgumentException("Arcane rejected an invalid Authenticode-probe path.");
                string requestedPath = Encoding.UTF8.GetString(encodedPath);
                string fullPath = Path.GetFullPath(requestedPath);
                if (!Path.IsPathRooted(requestedPath) || !String.Equals(requestedPath, fullPath, StringComparison.OrdinalIgnoreCase)
                    || !File.Exists(fullPath) || (File.GetAttributes(fullPath) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                    throw new InvalidDataException("Arcane Authenticode probe requires an exact regular file path.");
                SignatureEvidence evidence = Authenticode.VerifyCore(fullPath, purpose);
                Dictionary<string, object> response = new Dictionary<string, object>
                {
                    { "schemaVersion", 1 },
                    { "status", evidence.Status.ToString() },
                    { "signerThumbprint", evidence.SignerThumbprint },
                    { "details", evidence.Details },
                    { "timestampVerified", evidence.TimestampVerified },
                    { "verificationSource", evidence.VerificationSource }
                };
                Console.Out.Write(new JavaScriptSerializer().Serialize(response));
                Environment.ExitCode = 0;
            }
            catch (Exception error)
            {
                Console.Error.Write(error.ToString());
                Environment.ExitCode = 1;
            }
            return true;
        }

        internal static SignatureEvidence Verify(string file, AuthenticodePurpose purpose, TimeSpan timeout)
        {
            lock (ProbeLock) return VerifyLocked(file, purpose, timeout);
        }

        private static SignatureEvidence VerifyLocked(string file, AuthenticodePurpose purpose, TimeSpan timeout)
        {
            string fullPath = Path.GetFullPath(file);
            string encodedPath = Convert.ToBase64String(Encoding.UTF8.GetBytes(fullPath));
            string workerPath = Path.GetFullPath(Application.ExecutablePath);
            if (!File.Exists(workerPath) || (File.GetAttributes(workerPath) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                return new SignatureEvidence(SignatureStatus.Invalid, null, "Arcane Authenticode worker path is not an exact regular file.", false, "wintrust-probe-error");
            ProcessStartInfo start = new ProcessStartInfo(workerPath)
            {
                Arguments = ProbeArgument + " " + purpose.ToString() + " " + encodedPath,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            start.EnvironmentVariables.Clear();
            if (!String.IsNullOrWhiteSpace(windows))
            {
                start.EnvironmentVariables["SystemRoot"] = windows;
                start.EnvironmentVariables["WINDIR"] = windows;
            }
            BoundedProcessResult result;
            try { result = RunBoundedProcess(start, timeout); }
            catch (Exception error)
            {
                return new SignatureEvidence(SignatureStatus.Invalid, null, "Arcane Authenticode probe failed: " + error.Message, false, "wintrust-probe-error");
            }
            if (result.TimedOut)
                return new SignatureEvidence(SignatureStatus.TimedOut, null, "WinVerifyTrust worker exceeded Arcane's bounded verification time and was terminated.", false, "wintrust-timeout");
            if (result.ExitCode != 0)
                return new SignatureEvidence(SignatureStatus.Invalid, null, "Arcane Authenticode probe rejected the file: " + Truncate(result.StandardError, 4096), false, "wintrust-probe-error");
            try { return ParseEvidence(result.StandardOutput); }
            catch (Exception error)
            {
                return new SignatureEvidence(SignatureStatus.Invalid, null, "Arcane Authenticode probe returned invalid evidence: " + error.Message, false, "wintrust-probe-error");
            }
        }

        internal static BoundedProcessResult RunBoundedProcess(ProcessStartInfo start, TimeSpan timeout)
        {
            if (start == null || start.UseShellExecute || !start.RedirectStandardOutput || !start.RedirectStandardError)
                throw new ArgumentException("Arcane bounded process probes require redirected, non-shell execution.", "start");
            if (timeout <= TimeSpan.Zero || timeout > TimeSpan.FromMinutes(5)) throw new ArgumentOutOfRangeException("timeout");
            Process child = null;
            try
            {
                child = Process.Start(start);
                if (child == null) throw new InvalidOperationException("Microsoft NT did not start the Arcane Authenticode worker.");
                int processId = child.Id;
                Task<string> output = Task.Factory.StartNew(
                    delegate { return ReadBounded(child.StandardOutput, MaximumProbeOutput); },
                    CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
                Task<string> error = Task.Factory.StartNew(
                    delegate { return ReadBounded(child.StandardError, MaximumProbeOutput); },
                    CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
                Stopwatch clock = Stopwatch.StartNew();
                bool timedOut = false;
                while (!child.WaitForExit(0))
                {
                    if (output.IsFaulted || error.IsFaulted) break;
                    TimeSpan remaining = timeout - clock.Elapsed;
                    if (remaining <= TimeSpan.Zero) { timedOut = true; break; }
                    int wait = (int)Math.Min(1000, Math.Max(1, remaining.TotalMilliseconds));
                    if (child.WaitForExit(wait)) break;
                    ShellWatchdog.MarkVerifierHeartbeat();
                }
                if ((timedOut || output.IsFaulted || error.IsFaulted) && !child.HasExited)
                {
                    child.Kill();
                    if (!child.WaitForExit(5000)) throw new InvalidOperationException("Microsoft NT did not reap the timed-out Arcane Authenticode worker.");
                }
                child.WaitForExit();
                if (!Task.WaitAll(new Task[] { output, error }, 5000))
                    throw new InvalidDataException("Arcane could not drain Authenticode worker output.");
                string standardOutput = output.Result ?? "";
                string standardError = error.Result ?? "";
                if (standardOutput.Length > MaximumProbeOutput || standardError.Length > MaximumProbeOutput)
                    throw new InvalidDataException("Arcane Authenticode worker output exceeded its bound.");
                return new BoundedProcessResult(processId, timedOut, timedOut ? -1 : child.ExitCode, standardOutput, standardError);
            }
            finally
            {
                if (child != null)
                {
                    try
                    {
                        if (!child.HasExited)
                        {
                            child.Kill();
                            child.WaitForExit(5000);
                        }
                    }
                    catch { }
                    child.Dispose();
                }
            }
        }

        private static string ReadBounded(TextReader reader, int maximumCharacters)
        {
            char[] buffer = new char[4096];
            StringBuilder result = new StringBuilder();
            int read;
            while ((read = reader.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (result.Length + read > maximumCharacters)
                    throw new InvalidDataException("Arcane Authenticode worker output exceeded its bound.");
                result.Append(buffer, 0, read);
            }
            return result.ToString();
        }

        private static SignatureEvidence ParseEvidence(string json)
        {
            if (String.IsNullOrWhiteSpace(json) || json.Length > MaximumProbeOutput) throw new InvalidDataException("The Authenticode evidence payload is empty or oversized.");
            Dictionary<string, object> value = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
            if (value == null || value.Count != 6) throw new InvalidDataException("The Authenticode evidence payload is not an exact object.");
            foreach (string key in new[] { "schemaVersion", "status", "signerThumbprint", "details", "timestampVerified", "verificationSource" })
                if (!value.ContainsKey(key)) throw new InvalidDataException("The Authenticode evidence payload is missing " + key + ".");
            if (!(value["schemaVersion"] is int) || (int)value["schemaVersion"] != 1) throw new InvalidDataException("The Authenticode evidence schema is invalid.");
            string rawStatus = value["status"] as string;
            SignatureStatus status;
            try { status = (SignatureStatus)Enum.Parse(typeof(SignatureStatus), rawStatus, false); }
            catch (Exception error) { throw new InvalidDataException("The Authenticode evidence status is invalid.", error); }
            if (!Enum.IsDefined(typeof(SignatureStatus), status) || status == SignatureStatus.TimedOut)
                throw new InvalidDataException("The Authenticode worker returned an impossible status.");
            string signer = value["signerThumbprint"] as string;
            string details = value["details"] as string;
            string source = value["verificationSource"] as string;
            if (!(value["timestampVerified"] is bool) || String.IsNullOrWhiteSpace(details) || details.Length > 8192
                || String.IsNullOrWhiteSpace(source) || source.Length > 128)
                throw new InvalidDataException("The Authenticode evidence fields are invalid.");
            bool timestamp = (bool)value["timestampVerified"];
            if (status == SignatureStatus.Valid)
            {
                if (String.IsNullOrWhiteSpace(signer) || !Regex.IsMatch(signer, "^[A-Fa-f0-9]{40,128}$", RegexOptions.CultureInvariant) || !timestamp)
                    throw new InvalidDataException("Valid Authenticode evidence has no verified signer and timestamp.");
            }
            else if (signer != null || timestamp) throw new InvalidDataException("Failed Authenticode evidence unexpectedly contains signer material.");
            return new SignatureEvidence(status, signer, details, timestamp, source);
        }

        private static string Truncate(string value, int maximum)
        {
            string text = value ?? "";
            return text.Length <= maximum ? text : text.Substring(0, maximum);
        }
    }

    internal sealed class BoundedProcessResult
    {
        internal int ProcessId { get; private set; }
        internal bool TimedOut { get; private set; }
        internal int ExitCode { get; private set; }
        internal string StandardOutput { get; private set; }
        internal string StandardError { get; private set; }
        internal BoundedProcessResult(int processId, bool timedOut, int exitCode, string standardOutput, string standardError)
        {
            ProcessId = processId;
            TimedOut = timedOut;
            ExitCode = exitCode;
            StandardOutput = standardOutput;
            StandardError = standardError;
        }
    }

    internal enum SignatureStatus { Valid, NotSigned, Revoked, RevocationUnavailable, TimedOut, Invalid }
    internal enum AuthenticodePurpose { StrictOnline, OfflineBaseline, OfflineRevocation }

    internal sealed class SignatureEvidence
    {
        internal SignatureStatus Status { get; private set; }
        internal string SignerThumbprint { get; private set; }
        internal string Details { get; private set; }
        internal bool TimestampVerified { get; private set; }
        internal string VerificationSource { get; private set; }
        internal SignatureEvidence(SignatureStatus status, string signerThumbprint, string details, bool timestampVerified, string verificationSource)
        {
            Status = status;
            SignerThumbprint = signerThumbprint;
            Details = details;
            TimestampVerified = timestampVerified;
            VerificationSource = verificationSource;
        }
    }

    internal static class Authenticode
    {
        private static readonly Guid GenericVerifyV2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        private const int TrustENoSignature = unchecked((int)0x800B0100);
        private const int TrustESubjectFormUnknown = unchecked((int)0x800B0003);
        private const int TrustEProviderUnknown = unchecked((int)0x800B0001);
        private const int CryptERevoked = unchecked((int)0x80092010);
        private const int CertERevoked = unchecked((int)0x800B010C);
        private const int CryptENoRevocationDll = unchecked((int)0x80092011);
        private const int CryptENoRevocationCheck = unchecked((int)0x80092012);
        private const int CryptERevocationOffline = unchecked((int)0x80092013);
        private const int CryptENotInRevocationDatabase = unchecked((int)0x80092014);
        private const int CertERevocationFailure = unchecked((int)0x800B010E);
        private const uint RevocationCheckNone = 0x00000010;
        private const uint RevocationCheckChainExcludeRoot = 0x00000080;
        private const uint CacheOnlyUrlRetrieval = 0x00001000;
        private const uint DisableMd2Md4 = 0x00002000;
        private const uint SignerTypeTimestamp = 0x00000010;

        [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = true, PreserveSig = true)]
        private static extern int WinVerifyTrust(IntPtr window, ref Guid action, [In, Out] WinTrustData data);

        [DllImport("wintrust.dll", ExactSpelling = true, PreserveSig = true)]
        private static extern IntPtr WTHelperProvDataFromStateData(IntPtr stateData);

        [DllImport("wintrust.dll", ExactSpelling = true, PreserveSig = true)]
        private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr providerData, uint signerIndex, [MarshalAs(UnmanagedType.Bool)] bool counterSigner, uint counterSignerIndex);

        [DllImport("crypt32.dll", ExactSpelling = true, SetLastError = true, PreserveSig = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CertVerifyCertificateChainPolicy(IntPtr policy, IntPtr chainContext, ref CertChainPolicyParameters parameters, ref CertChainPolicyStatus status);

        internal static uint ProviderFlagsForPurpose(AuthenticodePurpose purpose)
        {
            if (purpose == AuthenticodePurpose.StrictOnline) return RevocationCheckChainExcludeRoot | DisableMd2Md4;
            if (purpose == AuthenticodePurpose.OfflineBaseline) return RevocationCheckNone | CacheOnlyUrlRetrieval | DisableMd2Md4;
            if (purpose == AuthenticodePurpose.OfflineRevocation) return RevocationCheckChainExcludeRoot | CacheOnlyUrlRetrieval | DisableMd2Md4;
            throw new ArgumentOutOfRangeException("purpose");
        }

        internal static SignatureStatus ClassifyTrustResult(int result)
        {
            if (result == 0) return SignatureStatus.Valid;
            if (result == TrustENoSignature) return SignatureStatus.NotSigned;
            if (result == CryptERevoked || result == CertERevoked) return SignatureStatus.Revoked;
            if (result == CryptENoRevocationDll || result == CryptENoRevocationCheck || result == CryptERevocationOffline
                || result == CryptENotInRevocationDatabase || result == CertERevocationFailure) return SignatureStatus.RevocationUnavailable;
            return SignatureStatus.Invalid;
        }

        internal static SignatureEvidence Verify(string file, AuthenticodePurpose purpose)
        {
            TimeSpan timeout = purpose == AuthenticodePurpose.StrictOnline ? TimeSpan.FromSeconds(20) : TimeSpan.FromSeconds(10);
            return AuthenticodeProbe.Verify(file, purpose, timeout);
        }

        internal static SignatureEvidence VerifyCore(string file, AuthenticodePurpose purpose)
        {
            using (WinTrustFileInfo fileInfo = new WinTrustFileInfo(file))
            using (WinTrustData trustData = new WinTrustData(fileInfo, ProviderFlagsForPurpose(purpose)))
            {
                Guid action = GenericVerifyV2;
                int result;
                ProviderEvidence providerEvidence = null;
                string providerError = null;
                try
                {
                    result = WinVerifyTrust(new IntPtr(-1), ref action, trustData);
                    if (result == 0)
                    {
                        try { providerEvidence = ReadProviderEvidence(trustData.StateData); }
                        catch (Exception error) { providerError = error.Message; }
                    }
                }
                finally
                {
                    trustData.PrepareToClose();
                    WinVerifyTrust(new IntPtr(-1), ref action, trustData);
                }
                SignatureStatus status = ClassifyTrustResult(result);
                string source = purpose == AuthenticodePurpose.StrictOnline ? "wintrust-online"
                    : purpose == AuthenticodePurpose.OfflineBaseline ? "wintrust-offline-baseline" : "wintrust-cache-revocation";
                if (status == SignatureStatus.Valid)
                {
                    if (providerEvidence == null)
                        return new SignatureEvidence(SignatureStatus.Invalid, null, "WinTrust provider evidence was incomplete: " + (providerError ?? "unknown provider-state error"), false, source);
                    return new SignatureEvidence(SignatureStatus.Valid, providerEvidence.SignerThumbprint,
                        "WinVerifyTrust validated the provider-selected Authenticode signer and timestamp chain.", true, source);
                }
                if (status == SignatureStatus.NotSigned)
                {
                    if (!HasEmptyPeCertificateTable(file))
                        return new SignatureEvidence(SignatureStatus.Invalid, null, "WinVerifyTrust reported no signature, but the PE certificate table was present or malformed.", false, source);
                    return new SignatureEvidence(status, null, "The PE file has no Authenticode certificate table.", false, source);
                }
                return new SignatureEvidence(status, null, "WinVerifyTrust returned 0x" + result.ToString("X8", CultureInfo.InvariantCulture) + ".", false, source);
            }
        }

        private static ProviderEvidence ReadProviderEvidence(IntPtr stateData)
        {
            if (stateData == IntPtr.Zero) throw new InvalidDataException("WinTrust returned no provider state.");
            IntPtr providerData = WTHelperProvDataFromStateData(stateData);
            if (providerData == IntPtr.Zero) throw new InvalidDataException("WinTrust returned no provider data.");
            CryptProviderData provider = (CryptProviderData)Marshal.PtrToStructure(providerData, typeof(CryptProviderData));
            if (provider.Error != 0 || provider.SignerCount != 1)
                throw new InvalidDataException("WinTrust provider data did not select exactly one error-free signer.");
            IntPtr signerPointer = WTHelperGetProvSignerFromChain(providerData, 0, false, 0);
            if (signerPointer == IntPtr.Zero) throw new InvalidDataException("WinTrust returned no selected primary signer.");
            CryptProviderSigner signer = ValidateProviderSigner(signerPointer, false);
            if (signer.CounterSignerCount != 1)
                throw new InvalidDataException("Arcane requires exactly one provider-selected Authenticode timestamp.");
            IntPtr timestampPointer = WTHelperGetProvSignerFromChain(providerData, 0, true, 0);
            if (timestampPointer == IntPtr.Zero) throw new InvalidDataException("WinTrust did not expose the Authenticode timestamp signer.");
            CryptProviderSigner timestamp = ValidateProviderSigner(timestampPointer, true);
            if (timestamp.CounterSignerCount != 0) throw new InvalidDataException("Arcane rejected a nested timestamp signer chain.");
            DateTime timestampTime = FileTimeUtc(timestamp.VerifyAsOf);
            if (timestampTime < new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc) || timestampTime > DateTime.UtcNow.AddDays(1))
                throw new InvalidDataException("WinTrust returned an implausible timestamp verification time.");
            string thumbprint = ProviderLeafThumbprint(signer.CertificateChain);
            return new ProviderEvidence(thumbprint, timestampTime);
        }

        private static CryptProviderSigner ValidateProviderSigner(IntPtr pointer, bool timestamp)
        {
            CryptProviderSigner signer = (CryptProviderSigner)Marshal.PtrToStructure(pointer, typeof(CryptProviderSigner));
            if (signer.StructureSize < (uint)Marshal.SizeOf(typeof(CryptProviderSigner)) || signer.Error != 0
                || signer.CertificateCount < 1 || signer.CertificateCount > 64 || signer.CertificateChain == IntPtr.Zero || signer.ChainContext == IntPtr.Zero)
                throw new InvalidDataException("WinTrust returned an incomplete or failed provider signer chain.");
            if (timestamp && signer.SignerType != SignerTypeTimestamp)
                throw new InvalidDataException("WinTrust countersigner is not an Authenticode timestamp signer.");
            CertChainContext chain = (CertChainContext)Marshal.PtrToStructure(signer.ChainContext, typeof(CertChainContext));
            if (chain.TrustStatus.ErrorStatus != 0) throw new InvalidDataException("WinTrust provider signer chain contains a trust error.");
            ValidateChainPolicy(signer.ChainContext, timestamp ? new IntPtr(3) : new IntPtr(2));
            int certificateSize = Marshal.SizeOf(typeof(CryptProviderCertificate));
            for (uint index = 0; index < signer.CertificateCount; index++)
            {
                IntPtr certificatePointer = new IntPtr(signer.CertificateChain.ToInt64() + (long)certificateSize * index);
                CryptProviderCertificate certificate = (CryptProviderCertificate)Marshal.PtrToStructure(certificatePointer, typeof(CryptProviderCertificate));
                if (certificate.StructureSize < (uint)certificateSize || certificate.CertificateContext == IntPtr.Zero
                    || certificate.Error != 0 || certificate.RevokedReason != 0)
                    throw new InvalidDataException("WinTrust provider certificate chain contains an invalid element.");
            }
            return signer;
        }

        private static void ValidateChainPolicy(IntPtr chainContext, IntPtr policy)
        {
            CertChainPolicyParameters parameters = new CertChainPolicyParameters();
            parameters.StructureSize = (uint)Marshal.SizeOf(typeof(CertChainPolicyParameters));
            CertChainPolicyStatus status = new CertChainPolicyStatus();
            status.StructureSize = (uint)Marshal.SizeOf(typeof(CertChainPolicyStatus));
            if (!CertVerifyCertificateChainPolicy(policy, chainContext, ref parameters, ref status) || status.Error != 0)
                throw new InvalidDataException("Microsoft NT certificate-chain policy rejected the provider signer.");
        }

        private static string ProviderLeafThumbprint(IntPtr certificateChain)
        {
            CryptProviderCertificate providerCertificate = (CryptProviderCertificate)Marshal.PtrToStructure(certificateChain, typeof(CryptProviderCertificate));
            CertContext context = (CertContext)Marshal.PtrToStructure(providerCertificate.CertificateContext, typeof(CertContext));
            if (context.EncodedCertificate == IntPtr.Zero || context.EncodedCertificateSize < 1 || context.EncodedCertificateSize > 1024 * 1024)
                throw new InvalidDataException("WinTrust provider signer certificate is malformed.");
            byte[] encoded = new byte[context.EncodedCertificateSize];
            Marshal.Copy(context.EncodedCertificate, encoded, 0, encoded.Length);
            using (X509Certificate2 certificate = new X509Certificate2(encoded))
            {
                if (String.IsNullOrWhiteSpace(certificate.Thumbprint)) throw new InvalidDataException("WinTrust provider signer certificate has no thumbprint.");
                return certificate.Thumbprint;
            }
        }

        private static DateTime FileTimeUtc(System.Runtime.InteropServices.ComTypes.FILETIME value)
        {
            long fileTime = ((long)(uint)value.dwHighDateTime << 32) | (uint)value.dwLowDateTime;
            try { return DateTime.FromFileTimeUtc(fileTime); }
            catch (ArgumentOutOfRangeException error) { throw new InvalidDataException("WinTrust returned an invalid signer verification time.", error); }
        }

        private static bool HasEmptyPeCertificateTable(string file)
        {
            try
            {
                using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (BinaryReader reader = new BinaryReader(stream, Encoding.UTF8))
                {
                    if (stream.Length < 64 || reader.ReadUInt16() != 0x5A4D) return false;
                    stream.Position = 0x3C;
                    int peOffset = reader.ReadInt32();
                    if (peOffset < 64 || peOffset > stream.Length - 24) return false;
                    stream.Position = peOffset;
                    if (reader.ReadUInt32() != 0x00004550) return false;
                    stream.Position = peOffset + 20;
                    ushort optionalSize = reader.ReadUInt16();
                    long optionalOffset = peOffset + 24;
                    if (optionalSize < 2 || optionalOffset + optionalSize > stream.Length) return false;
                    stream.Position = optionalOffset;
                    ushort magic = reader.ReadUInt16();
                    int dataDirectoryOffset = magic == 0x10B ? 96 : magic == 0x20B ? 112 : -1;
                    int securityDirectoryEnd = dataDirectoryOffset + (5 * 8);
                    if (dataDirectoryOffset < 0 || optionalSize < securityDirectoryEnd) return false;
                    stream.Position = optionalOffset + dataDirectoryOffset + (4 * 8);
                    uint certificateOffset = reader.ReadUInt32();
                    uint certificateSize = reader.ReadUInt32();
                    return certificateOffset == 0 && certificateSize == 0;
                }
            }
            catch { return false; }
        }

        private sealed class ProviderEvidence
        {
            internal string SignerThumbprint { get; private set; }
            internal DateTime TimestampUtc { get; private set; }
            internal ProviderEvidence(string signerThumbprint, DateTime timestampUtc) { SignerThumbprint = signerThumbprint; TimestampUtc = timestampUtc; }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CryptProviderData
        {
            internal uint StructureSize;
            internal IntPtr WinTrustData;
            internal int OpenedFile;
            internal IntPtr ParentWindow;
            internal IntPtr ActionId;
            internal IntPtr Provider;
            internal uint Error;
            internal uint RegistrySecuritySettings;
            internal uint RegistryPolicySettings;
            internal IntPtr ProviderFunctions;
            internal uint TrustStepErrorCount;
            internal IntPtr TrustStepErrors;
            internal uint StoreCount;
            internal IntPtr Stores;
            internal uint Encoding;
            internal IntPtr Message;
            internal uint SignerCount;
            internal IntPtr Signers;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CryptProviderSigner
        {
            internal uint StructureSize;
            internal System.Runtime.InteropServices.ComTypes.FILETIME VerifyAsOf;
            internal uint CertificateCount;
            internal IntPtr CertificateChain;
            internal uint SignerType;
            internal IntPtr SignerInfo;
            internal uint Error;
            internal uint CounterSignerCount;
            internal IntPtr CounterSigners;
            internal IntPtr ChainContext;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CryptProviderCertificate
        {
            internal uint StructureSize;
            internal IntPtr CertificateContext;
            internal int Commercial;
            internal int TrustedRoot;
            internal int SelfSigned;
            internal int TestCertificate;
            internal uint RevokedReason;
            internal uint Confidence;
            internal uint Error;
            internal IntPtr TrustListContext;
            internal int TrustListSignerCertificate;
            internal IntPtr CtlContext;
            internal uint CtlError;
            internal int Cyclic;
            internal IntPtr ChainElement;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CertContext
        {
            internal uint EncodingType;
            internal IntPtr EncodedCertificate;
            internal uint EncodedCertificateSize;
            internal IntPtr CertificateInfo;
            internal IntPtr CertificateStore;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CertTrustStatus
        {
            internal uint ErrorStatus;
            internal uint InfoStatus;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CertChainContext
        {
            internal uint StructureSize;
            internal CertTrustStatus TrustStatus;
            internal uint ChainCount;
            internal IntPtr Chains;
            internal uint LowerQualityChainCount;
            internal IntPtr LowerQualityChains;
            internal int HasRevocationFreshnessTime;
            internal uint RevocationFreshnessTime;
            internal uint CreateFlags;
            internal Guid ChainId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CertChainPolicyParameters
        {
            internal uint StructureSize;
            internal uint Flags;
            internal IntPtr ExtraPolicyParameters;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CertChainPolicyStatus
        {
            internal uint StructureSize;
            internal uint Error;
            internal int ChainIndex;
            internal int ElementIndex;
            internal IntPtr ExtraPolicyStatus;
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
            private uint stateAction = 1;
            private IntPtr stateData = IntPtr.Zero;
            private IntPtr urlReference = IntPtr.Zero;
            private uint providerFlags = 0;
            private uint uiContext = 0;
            internal IntPtr StateData { get { return stateData; } }
            internal WinTrustData(WinTrustFileInfo info, uint flags)
            {
                providerFlags = flags;
                fileInfo = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WinTrustFileInfo)));
                Marshal.StructureToPtr(info, fileInfo, false);
            }
            internal void PrepareToClose() { stateAction = 2; }
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

    internal static class NativeWindowTheme
    {
        private const int DwmUseImmersiveDarkMode = 20;
        private const int DwmUseImmersiveDarkModeBefore20H1 = 19;
        private const int DwmCaptionColor = 35;
        private const int DwmTextColor = 36;
        private const uint DwmColorDefault = 0xffffffff;

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref uint value, int size);

        internal static void Apply(IntPtr window)
        {
            if (window == IntPtr.Zero) return;
            try
            {
                string scheme = ReadString(@"Software\Arcane OS\Appearance", "Scheme");
                bool dark = String.Equals(scheme, "dark", StringComparison.OrdinalIgnoreCase)
                    || (!String.Equals(scheme, "light", StringComparison.OrdinalIgnoreCase) && ReadDword(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1) == 0);
                int enabled = dark ? 1 : 0;
                if (DwmSetWindowAttribute(window, DwmUseImmersiveDarkMode, ref enabled, sizeof(int)) != 0)
                    DwmSetWindowAttribute(window, DwmUseImmersiveDarkModeBefore20H1, ref enabled, sizeof(int));

                uint caption = ParseColor(ReadString(@"Software\Arcane OS\Appearance", "CaptionColor"));
                uint text = ParseColor(ReadString(@"Software\Arcane OS\Appearance", "TextColor"));
                DwmSetWindowAttribute(window, DwmCaptionColor, ref caption, sizeof(uint));
                DwmSetWindowAttribute(window, DwmTextColor, ref text, sizeof(uint));
            }
            catch { }
        }

        internal static string AppearanceChangedEvent()
        {
            string scheme = ReadString(@"Software\Arcane OS\Appearance", "Scheme");
            if (!String.Equals(scheme, "light", StringComparison.OrdinalIgnoreCase)
                && !String.Equals(scheme, "dark", StringComparison.OrdinalIgnoreCase)) scheme = "system";
            bool dark = String.Equals(scheme, "dark", StringComparison.OrdinalIgnoreCase)
                || (String.Equals(scheme, "system", StringComparison.OrdinalIgnoreCase)
                    && ReadDword(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1) == 0);
            return "{\"protocol\":\"arcane/1\",\"type\":\"event\",\"event\":\"appearance.changed\",\"data\":{\"scheme\":\""
                + scheme.ToLowerInvariant() + "\",\"effectiveScheme\":\"" + (dark ? "dark" : "light") + "\",\"source\":\"windows\"}}";
        }

        private static int ReadDword(string path, string name, int fallback)
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(path, false))
            {
                object value = key == null ? null : key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                return value is int ? (int)value : fallback;
            }
        }

        private static string ReadString(string path, string name)
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(path, false))
            {
                return key == null ? null : key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
            }
        }

        private static uint ParseColor(string value)
        {
            if (String.IsNullOrWhiteSpace(value)) return DwmColorDefault;
            System.Text.RegularExpressions.Match match = System.Text.RegularExpressions.Regex.Match(value, @"^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (!match.Success) return DwmColorDefault;
            int red, green, blue;
            if (!Int32.TryParse(match.Groups[1].Value, out red) || !Int32.TryParse(match.Groups[2].Value, out green) || !Int32.TryParse(match.Groups[3].Value, out blue)
                || red > 255 || green > 255 || blue > 255) return DwmColorDefault;
            return (uint)(red | (green << 8) | (blue << 16));
        }
    }

    internal sealed class StartupBackdrop : Form
    {
        private static readonly string[] StageIds = new string[]
        {
            "walk", "handles", "hash", "authenticode", "firstboot", "form", "core", "webview", "navigate"
        };

        private const string BootHtml = @"<!doctype html>
<html lang=""en""><head><meta charset=""utf-8""><meta http-equiv=""X-UA-Compatible"" content=""IE=edge""><title>Arcane secure startup</title>
<style>
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:rgb(3,5,10);color:rgb(238,242,255);font-family:'Segoe UI',Arial,sans-serif}
body{background:radial-gradient(circle at 50% 18%,rgba(76,102,214,.22),rgba(3,5,10,0) 34%),linear-gradient(180deg,rgb(2,4,10),rgb(5,7,13) 58%,rgb(3,5,10))}
.shell{height:100%;position:relative}.frame{position:absolute;left:22px;right:22px;top:22px;bottom:22px;border:1px solid rgba(145,166,235,.18);border-radius:22px}
.panel{position:absolute;width:760px;left:50%;top:50%;margin-left:-380px;margin-top:-335px}.eyebrow{color:rgb(146,155,181);font-size:11px;letter-spacing:3px;text-transform:uppercase}
h1{font-size:40px;font-weight:300;letter-spacing:7px;margin:12px 0 6px;text-transform:uppercase}.intro{color:rgb(174,183,210);font-size:14px;line-height:1.6;margin:0 0 22px}
.trust{border:1px solid rgba(143,124,255,.28);border-radius:16px;background:rgba(8,13,24,.88);box-shadow:0 24px 80px rgba(0,0,0,.30);padding:22px 24px}
.headline{font-size:15px;margin-bottom:13px}.bar{height:7px;border-radius:8px;background:rgba(255,255,255,.07);overflow:hidden}.fill{height:100%;width:1%;background:linear-gradient(90deg,rgb(99,118,232),rgb(143,124,255));transition:width .16s ease}
.steps{list-style:none;margin:20px 0 0;padding:0}.step{position:relative;min-height:39px;padding:0 0 0 34px;color:rgb(146,155,181)}.step:before{content:'';position:absolute;left:5px;top:5px;width:10px;height:10px;border:2px solid rgba(146,155,181,.42);border-radius:50%}.step:after{content:'';position:absolute;left:11px;top:19px;width:1px;height:24px;background:rgba(146,155,181,.22)}.step:last-child:after{display:none}
.step.active{color:rgb(238,242,255)}.step.active:before{border-color:rgb(143,124,255);background:rgb(143,124,255);box-shadow:0 0 15px rgba(143,124,255,.8)}.step.complete{color:rgb(190,243,212)}.step.complete:before{border-color:rgb(113,215,162);background:rgb(113,215,162)}.step.skipped{color:rgb(174,183,210)}.step.skipped:before{border-color:rgb(174,183,210)}.step.failed{color:rgb(255,198,204)}.step.failed:before{border-color:rgb(255,141,154);background:rgb(255,141,154)}
.name{display:inline-block;font-size:13px}.state{float:right;font-size:10px;letter-spacing:1.4px;text-transform:uppercase}.detail{display:block;clear:both;padding-top:3px;font-size:11px;color:rgb(146,155,181);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.footer{margin-top:17px;color:rgb(113,215,162);font-size:11px;letter-spacing:1.2px;text-transform:uppercase}.pulse{display:inline-block;width:7px;height:7px;margin-right:9px;border-radius:50%;background:rgb(113,215,162);box-shadow:0 0 14px rgba(113,215,162,.8)}
</style></head><body><div class=""shell""><div class=""frame""></div><main class=""panel"" aria-labelledby=""boot-title""><div class=""eyebrow"">Trusted startup environment</div><h1 id=""boot-title"">Arcane OS</h1><p class=""intro"">The shell is verifying its protected runtime before granting access to the desktop.</p><section class=""trust"" aria-live=""polite""><div id=""headline"" class=""headline"">Preparing the secure startup sequence…</div><div class=""bar"" role=""progressbar"" aria-label=""Arcane shell startup progress"" aria-valuemin=""0"" aria-valuemax=""100""><div id=""overall-fill"" class=""fill""></div></div><ol class=""steps"">
<li id=""stage-walk"" class=""step""><span class=""name"">Walk the release directory</span><span id=""state-walk"" class=""state"">Pending</span><span id=""detail-walk"" class=""detail"">Waiting to inspect the release boundary.</span></li>
<li id=""stage-handles"" class=""step""><span class=""name"">Retain protected directory and file handles</span><span id=""state-handles"" class=""state"">Pending</span><span id=""detail-handles"" class=""detail"">Waiting to bind verified objects to this process.</span></li>
<li id=""stage-hash"" class=""step""><span class=""name"">Verify SHA-256 content hashes</span><span id=""state-hash"" class=""state"">Pending</span><span id=""detail-hash"" class=""detail"">Waiting for the signed content manifest.</span></li>
<li id=""stage-authenticode"" class=""step""><span class=""name"">Authenticate native executables</span><span id=""state-authenticode"" class=""state"">Pending</span><span id=""detail-authenticode"" class=""detail"">Waiting to start bounded Microsoft NT trust workers.</span></li>
<li id=""stage-firstboot"" class=""step""><span class=""name"">Apply first-boot user setup</span><span id=""state-firstboot"" class=""state"">Pending</span><span id=""detail-firstboot"" class=""detail"">Runs only when an idempotent setup step is required.</span></li>
<li id=""stage-form"" class=""step""><span class=""name"">Construct the trusted shell window</span><span id=""state-form"" class=""state"">Pending</span><span id=""detail-form"" class=""detail"">Waiting for security verification.</span></li>
<li id=""stage-core"" class=""step""><span class=""name"">Start Arcane Core</span><span id=""state-core"" class=""state"">Pending</span><span id=""detail-core"" class=""detail"">Waiting to establish the local protocol bridge.</span></li>
<li id=""stage-webview"" class=""step""><span class=""name"">Create the WebView2 environment</span><span id=""state-webview"" class=""state"">Pending</span><span id=""detail-webview"" class=""detail"">Waiting to create the isolated renderer controller.</span></li>
<li id=""stage-navigate"" class=""step""><span class=""name"">Navigate to the verified shell</span><span id=""state-navigate"" class=""state"">Pending</span><span id=""detail-navigate"" class=""detail"">The boot surface remains until navigation succeeds.</span></li>
</ol><div class=""footer""><span class=""pulse""></span>Local verification in progress</div></section></main></div></body></html>";

        private readonly WebBrowser browser;
        private readonly Stopwatch updateClock = Stopwatch.StartNew();
        private bool documentReady;
        private bool allowClose;
        private double overallProgress = 0.01;

        private StartupBackdrop()
        {
            AutoScaleMode = AutoScaleMode.Dpi;
            BackColor = Program.StartupBackgroundColor;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = true;
            StartPosition = FormStartPosition.Manual;
            Bounds = Screen.PrimaryScreen.Bounds;
            Text = "Starting Arcane";
            TopMost = true;
            browser = new WebBrowser
            {
                AllowWebBrowserDrop = false,
                BackColor = Program.StartupBackgroundColor,
                Dock = DockStyle.Fill,
                IsWebBrowserContextMenuEnabled = false,
                ScriptErrorsSuppressed = true,
                ScrollBarsEnabled = false,
                Visible = false,
                WebBrowserShortcutsEnabled = false
            };
            browser.DocumentCompleted += delegate
            {
                if (browser.Document == null || browser.ReadyState != WebBrowserReadyState.Complete
                    || browser.Document.GetElementById("boot-title") == null) return;
                documentReady = true;
                browser.Visible = true;
                browser.BringToFront();
            };
            Controls.Add(browser);
        }

        protected override void OnFormClosing(FormClosingEventArgs eventArgs)
        {
            if (!allowClose) { eventArgs.Cancel = true; return; }
            base.OnFormClosing(eventArgs);
        }

        internal static StartupBackdrop ShowNow()
        {
            StartupBackdrop backdrop = new StartupBackdrop();
            backdrop.Show();
            backdrop.Refresh();
            Application.DoEvents();
            backdrop.documentReady = false;
            backdrop.browser.DocumentText = BootHtml;
            Stopwatch paintDeadline = Stopwatch.StartNew();
            while (!backdrop.documentReady && paintDeadline.Elapsed < TimeSpan.FromSeconds(2)) Application.DoEvents();
            if (!backdrop.documentReady)
            {
                backdrop.allowClose = true;
                backdrop.Close();
                throw new InvalidOperationException("Arcane could not paint its trusted HTML startup surface.");
            }
            backdrop.BeginStage("walk", "Preparing to inspect the release boundary…");
            return backdrop;
        }

        internal void BeginStage(string stageId, string detail) { SetStage(stageId, "active", "In progress", detail, 0.05); }
        internal void CompleteStage(string stageId, string detail) { SetStage(stageId, "complete", "Verified", detail, 1.0); }
        internal void SkipStage(string stageId, string detail) { SetStage(stageId, "skipped", "Not required", detail, 1.0); }
        internal void FailStage(string stageId, string detail) { SetStage(stageId, "failed", "Stopped", detail, 0.0); }

        internal void ReportDirectoryProgress(int openedCount)
        {
            if (openedCount > 1 && openedCount % 4 != 0 && updateClock.ElapsedMilliseconds < 60) return;
            updateClock.Restart();
            SetStage("walk", "active", "In progress", openedCount.ToString(CultureInfo.InvariantCulture) + " directories inspected.", 0.45);
            SetStage("handles", "active", "In progress", openedCount.ToString(CultureInfo.InvariantCulture) + " protected directory handles retained.", 0.45);
        }

        internal void BeginHashVerification(int fileCount, long totalBytes)
        {
            BeginStage("hash", "Preparing to verify " + fileCount.ToString(CultureInfo.InvariantCulture) + " files / " + FormatMib(totalBytes) + " MiB.");
        }

        internal void ReportFileHandleProgress(int current, int total)
        {
            if (current < total && updateClock.ElapsedMilliseconds < 55) return;
            updateClock.Restart();
            double fraction = total < 1 ? 0.0 : (double)current / total;
            SetStage("handles", "active", "In progress", current.ToString(CultureInfo.InvariantCulture) + " of "
                + total.ToString(CultureInfo.InvariantCulture) + " manifest file handles retained.", fraction);
        }

        internal void ReportHashProgress(int current, int total, long verifiedBytes, long totalBytes)
        {
            if (current < total && updateClock.ElapsedMilliseconds < 55) return;
            updateClock.Restart();
            double fraction = total < 1 ? 0.0 : (double)current / total;
            SetStage("hash", "active", "In progress", current.ToString(CultureInfo.InvariantCulture) + " of " + total.ToString(CultureInfo.InvariantCulture)
                + " files · " + FormatMib(verifiedBytes) + " of " + FormatMib(totalBytes) + " MiB verified.", fraction);
        }

        internal void CompleteHashVerification(int fileCount, long totalBytes)
        {
            CompleteStage("hash", fileCount.ToString(CultureInfo.InvariantCulture) + " files / " + FormatMib(totalBytes) + " MiB match the SHA-256 manifest.");
        }

        internal void BeginAuthenticodeVerification(int executableCount)
        {
            BeginStage("authenticode", "Preparing " + executableCount.ToString(CultureInfo.InvariantCulture) + " bounded Microsoft NT trust checks.");
        }

        internal void ReportAuthenticodeProgress(int current, int total, string fileName, bool complete)
        {
            double fraction = total < 1 ? 0.0 : (double)(complete ? current : current - 0.5) / total;
            string action = complete ? "Authenticated" : "Checking";
            SetStage("authenticode", "active", "In progress", action + " " + current.ToString(CultureInfo.InvariantCulture) + " of "
                + total.ToString(CultureInfo.InvariantCulture) + ": " + (fileName ?? "native executable") + ".", fraction);
        }

        internal void CompleteAuthenticodeVerification(int executableCount)
        {
            CompleteStage("authenticode", executableCount.ToString(CultureInfo.InvariantCulture) + " native executables passed the configured trust policy.");
        }

        private void SetStage(string stageId, string state, string stateLabel, string detail, double fraction)
        {
            int index = StageIndex(stageId);
            if (index < 0 || !documentReady || browser.Document == null) return;
            HtmlElement row = browser.Document.GetElementById("stage-" + stageId);
            HtmlElement stateElement = browser.Document.GetElementById("state-" + stageId);
            HtmlElement detailElement = browser.Document.GetElementById("detail-" + stageId);
            HtmlElement headline = browser.Document.GetElementById("headline");
            HtmlElement fill = browser.Document.GetElementById("overall-fill");
            if (row != null) row.SetAttribute("className", "step " + state);
            if (stateElement != null) stateElement.InnerText = stateLabel ?? "";
            if (detailElement != null) detailElement.InnerText = detail ?? "";
            if (headline != null && (state == "active" || state == "failed")) headline.InnerText = detail ?? "Arcane secure startup is in progress…";
            double progress = Math.Max(0.01, Math.Min(1.0, (index + Math.Max(0.0, Math.Min(1.0, fraction))) / StageIds.Length));
            overallProgress = Math.Max(overallProgress, progress);
            if (fill != null) fill.SetAttribute("style", "width:" + Math.Round(overallProgress * 100.0, 1).ToString(CultureInfo.InvariantCulture) + "%");
            browser.Update();
            Update();
            Application.DoEvents();
        }

        private static int StageIndex(string stageId)
        {
            for (int index = 0; index < StageIds.Length; index++) if (String.Equals(StageIds[index], stageId, StringComparison.Ordinal)) return index;
            return -1;
        }

        private static string FormatMib(long bytes)
        {
            return ((double)bytes / (1024.0 * 1024.0)).ToString("0.0", CultureInfo.InvariantCulture);
        }

        internal static void CloseSafely(StartupBackdrop backdrop)
        {
            if (backdrop == null) return;
            backdrop.allowClose = true;
            try { backdrop.Close(); } catch { }
            try { backdrop.Dispose(); } catch { }
        }
    }

    internal static class ApplicationDataLayout
    {
        private const int MaximumApplicationIdLength = 64;
        private static readonly Regex ApplicationIdPattern = new Regex("^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", RegexOptions.CultureInvariant);
        private static readonly Regex ReservedApplicationIdPattern = new Regex("^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.].*)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        internal static string PrepareWebView2Profile(string applicationId)
        {
            string localApplicationData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (String.IsNullOrWhiteSpace(localApplicationData))
            {
                throw new InvalidOperationException("Arcane could not resolve the current user's local application-data directory.");
            }
            return PrepareWebView2Profile(localApplicationData, applicationId);
        }

        internal static string PrepareWebView2Profile(string localApplicationData, string applicationId)
        {
            ValidateApplicationId(applicationId);
            if (String.IsNullOrWhiteSpace(localApplicationData)) throw new ArgumentException("A local application-data directory is required.", "localApplicationData");

            string localRoot = NormalizeDirectoryPath(localApplicationData);
            string arcaneRoot = ResolveChildDirectory(localRoot, "Arcane OS");
            string applicationsRoot = ResolveChildDirectory(arcaneRoot, "apps");
            string applicationRoot = ResolveChildDirectory(applicationsRoot, applicationId);
            string targetProfile = ResolveChildDirectory(applicationRoot, "webview2");
            string legacyProfilesRoot = ResolveChildDirectory(arcaneRoot, "WebView2");
            string legacyProfile = ResolveChildDirectory(legacyProfilesRoot, applicationId);

            EnsureRegularDirectory(arcaneRoot, "Arcane application-data root");
            EnsureRegularDirectory(applicationsRoot, "Arcane applications data root");
            EnsureRegularDirectory(applicationRoot, "Arcane application data root");

            bool targetExists = InspectRegularDirectory(targetProfile, "Arcane application WebView2 profile");
            bool legacyRootExists = InspectRegularDirectory(legacyProfilesRoot, "legacy Arcane WebView2 profiles root");
            bool legacyExists = legacyRootExists && InspectRegularDirectory(legacyProfile, "legacy Arcane application WebView2 profile");

            if (targetExists && legacyExists)
            {
                throw new InvalidDataException(
                    "Arcane found both the app-scoped WebView2 profile and its legacy profile for '" + applicationId
                    + "'. Arcane will not merge or choose between two profile directories. Move one profile aside after preserving it, then reopen the application.");
            }

            if (!targetExists && legacyExists)
            {
                if (InspectRegularDirectory(targetProfile, "Arcane application WebView2 profile"))
                {
                    throw new InvalidDataException("Arcane refused to merge a legacy WebView2 profile into an app-scoped profile that appeared during migration.");
                }
                InspectRequiredRegularDirectory(legacyProfilesRoot, "legacy Arcane WebView2 profiles root");
                InspectRequiredRegularDirectory(legacyProfile, "legacy Arcane application WebView2 profile");
                Directory.Move(legacyProfile, targetProfile);
                if (InspectRegularDirectory(legacyProfile, "legacy Arcane application WebView2 profile"))
                {
                    throw new IOException("Arcane could not complete the legacy WebView2 profile move because the source directory still exists.");
                }
                InspectRequiredRegularDirectory(targetProfile, "Arcane application WebView2 profile");
                targetExists = true;
            }

            if (!targetExists) EnsureRegularDirectory(targetProfile, "Arcane application WebView2 profile");

            InspectRequiredRegularDirectory(arcaneRoot, "Arcane application-data root");
            InspectRequiredRegularDirectory(applicationsRoot, "Arcane applications data root");
            InspectRequiredRegularDirectory(applicationRoot, "Arcane application data root");
            InspectRequiredRegularDirectory(targetProfile, "Arcane application WebView2 profile");
            if (InspectRegularDirectory(legacyProfile, "legacy Arcane application WebView2 profile"))
            {
                throw new InvalidDataException("Arcane refused to continue while both legacy and app-scoped WebView2 profiles exist.");
            }
            return targetProfile;
        }

        private static void ValidateApplicationId(string applicationId)
        {
            if (String.IsNullOrWhiteSpace(applicationId)
                || applicationId.Length > MaximumApplicationIdLength
                || !ApplicationIdPattern.IsMatch(applicationId)
                || ReservedApplicationIdPattern.IsMatch(applicationId))
            {
                throw new ArgumentException("Arcane requires a canonical application identifier before resolving app data.", "applicationId");
            }
        }

        private static string NormalizeDirectoryPath(string path)
        {
            string fullPath = Path.GetFullPath(path);
            string volumeRoot = Path.GetPathRoot(fullPath);
            string trimmedPath = fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string trimmedVolumeRoot = (volumeRoot ?? "").TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (String.Equals(trimmedPath, trimmedVolumeRoot, StringComparison.OrdinalIgnoreCase)) return volumeRoot;
            return trimmedPath;
        }

        private static string ResolveChildDirectory(string parent, string childName)
        {
            string normalizedParent = NormalizeDirectoryPath(parent);
            string child = NormalizeDirectoryPath(Path.Combine(normalizedParent, childName));
            string prefix = normalizedParent.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
                || normalizedParent.EndsWith(Path.AltDirectorySeparatorChar.ToString(), StringComparison.Ordinal)
                ? normalizedParent
                : normalizedParent + Path.DirectorySeparatorChar;
            if (!child.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("Arcane rejected an application-data path outside its expected parent directory.");
            }
            return child;
        }

        private static void EnsureRegularDirectory(string path, string description)
        {
            if (!InspectRegularDirectory(path, description)) Directory.CreateDirectory(path);
            InspectRequiredRegularDirectory(path, description);
        }

        private static void InspectRequiredRegularDirectory(string path, string description)
        {
            if (!InspectRegularDirectory(path, description))
            {
                throw new DirectoryNotFoundException("Arcane could not resolve the " + description + " at '" + path + "'.");
            }
        }

        private static bool InspectRegularDirectory(string path, string description)
        {
            FileAttributes attributes;
            try
            {
                attributes = File.GetAttributes(path);
            }
            catch (FileNotFoundException)
            {
                return false;
            }
            catch (DirectoryNotFoundException)
            {
                return false;
            }
            if ((attributes & FileAttributes.Directory) == 0)
            {
                throw new InvalidDataException("Arcane expected the " + description + " to be a directory: '" + path + "'.");
            }
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidDataException("Arcane refused a reparse point at the " + description + ": '" + path + "'.");
            }
            return true;
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
        private int onlineRefreshStarted;
        private readonly CancellationTokenSource onlineRefreshCancellation = new CancellationTokenSource();
        private readonly System.Windows.Forms.Timer watchdogHeartbeatTimer;
        private StartupBackdrop startupBackdrop;

        public ArcaneForm(string[] args, ReleaseSecurityResult verifiedRelease, StartupBackdrop backdrop)
        {
            launchArgs = args ?? new string[0];
            if (verifiedRelease == null) throw new ArgumentNullException("verifiedRelease");
            releaseSecurity = verifiedRelease;
            startupBackdrop = backdrop;
            AutoScaleMode = AutoScaleMode.Dpi;
            BackColor = Program.StartupBackgroundColor;
            Text = Program.ProductName;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(900, 650);
            Size = Program.AppMode == "shell" ? Screen.PrimaryScreen.Bounds.Size : new Size(1240, 860);
            if (Program.AppMode == "shell")
            {
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Maximized;
                TopMost = false;
                watchdogHeartbeatTimer = new System.Windows.Forms.Timer { Interval = 2000 };
                watchdogHeartbeatTimer.Tick += delegate { ShellWatchdog.MarkUiHeartbeat(); };
            }
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            webView = new WebView2
            {
                BackColor = Program.StartupBackgroundColor,
                Dock = DockStyle.Fill
            };
            Controls.Add(webView);
            Shown += delegate
            {
                NativeWindowTheme.Apply(Handle);
            };
            SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;
            Load += async delegate
            {
                StartOnlineSecurityRefresh();
                await InitializeAsync();
            };
            FormClosing += OnFormClosing;
        }

        protected override void OnHandleCreated(EventArgs eventArgs)
        {
            base.OnHandleCreated(eventArgs);
            NativeWindowTheme.Apply(Handle);
        }

        private void OnUserPreferenceChanged(object sender, UserPreferenceChangedEventArgs eventArgs)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke(new Action(delegate
                {
                    if (IsDisposed) return;
                    NativeWindowTheme.Apply(Handle);
                    string message = NativeWindowTheme.AppearanceChangedEvent();
                    if (!webReady || webView.CoreWebView2 == null) pendingMessages.Enqueue(message);
                    else PostMessage(message);
                }));
            }
            catch { }
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

                if (startupBackdrop != null) startupBackdrop.BeginStage("core", "Starting the isolated Arcane Core process…");
                core = ArcaneCoreProcess.Start(bundleRoot, Program.AppMode, launchArgs, releaseSecurity);
                core.MessageReceived += DeliverCoreMessage;
                core.Failed += delegate(string message) { BeginInvoke(new Action(delegate { ShowFatal("Arcane Core stopped", message); })); };
                if (startupBackdrop != null) startupBackdrop.CompleteStage("core", "Arcane Core started and the local protocol bridge is connected.");

                if (startupBackdrop != null) startupBackdrop.BeginStage("webview", "Checking the installed WebView2 Runtime…");
                await EnsureWebViewRuntimeAsync();
                string userData = ApplicationDataLayout.PrepareWebView2Profile(Program.AppMode);
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userData);
                CoreWebView2ControllerOptions controllerOptions = environment.CreateCoreWebView2ControllerOptions();
                controllerOptions.DefaultBackgroundColor = Program.StartupBackgroundColor;
                await webView.EnsureCoreWebView2Async(environment, controllerOptions);
                if (startupBackdrop != null) startupBackdrop.CompleteStage("webview", "The isolated WebView2 environment and controller are ready.");

                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = HasArg("--devtools");
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
                webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = Program.AppMode != "shell";
                webView.CoreWebView2.SetVirtualHostNameToFolderMapping("arcane.local", webRoot, CoreWebView2HostResourceAccessKind.DenyCors);
                webView.CoreWebView2.AddHostObjectToScript("arcaneBridge", new ArcaneBridge(core));
                webView.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs eventArgs)
                {
                    if (IsAllowedAppUri(eventArgs.Uri)) return;
                    eventArgs.Cancel = true;
                    TryOpenExternalUri(eventArgs.Uri);
                };
                webView.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs eventArgs)
                {
                    eventArgs.Handled = true;
                    TryOpenExternalUri(eventArgs.Uri);
                };
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
                webView.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs eventArgs)
                {
                    if (!eventArgs.IsSuccess)
                    {
                        if (startupBackdrop != null) startupBackdrop.FailStage("navigate", "Verified shell navigation failed: " + eventArgs.WebErrorStatus.ToString() + ".");
                        StartupBackdrop.CloseSafely(startupBackdrop);
                        startupBackdrop = null;
                        ShowFatal("Arcane application navigation failed", eventArgs.WebErrorStatus.ToString());
                        return;
                    }
                    webReady = true;
                    string message;
                    while (pendingMessages.TryDequeue(out message)) PostMessage(message);
                    if (Program.AppMode == "shell")
                    {
                        ShellWatchdog.MarkUiReady();
                        watchdogHeartbeatTimer.Start();
                    }
                    if (startupBackdrop != null) startupBackdrop.CompleteStage("navigate", "Verified shell navigation completed; handing off to Arcane OS.");
                    StartupBackdrop.CloseSafely(startupBackdrop);
                    startupBackdrop = null;
                };
                if (startupBackdrop != null) startupBackdrop.BeginStage("navigate", "Navigating to the verified Arcane shell document…");
                webView.Source = new Uri("https://arcane.local" + navigationPath);
            }
            catch (Exception error)
            {
                if (startupBackdrop != null) startupBackdrop.FailStage("navigate", "Startup stopped before the verified shell could render.");
                StartupBackdrop.CloseSafely(startupBackdrop);
                startupBackdrop = null;
                ShowFatal("Arcane could not start", error.ToString());
            }
        }

        private bool HasArg(string name)
        {
            foreach (string value in launchArgs) if (String.Equals(value, name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private void StartOnlineSecurityRefresh()
        {
            if (!String.Equals(releaseSecurity.RevocationStatus, "attested-degraded", StringComparison.Ordinal)
                || Interlocked.Exchange(ref onlineRefreshStarted, 1) != 0) return;
            RefreshOnlineSecurityAsync();
        }

        private async void RefreshOnlineSecurityAsync()
        {
            try
            {
                int delaySeconds = 30;
                while (!onlineRefreshCancellation.IsCancellationRequested)
                {
                    releaseSecurity.RemainingDegradedLifetime(DateTimeOffset.UtcNow);
                    bool refreshed = await Task.Run((Func<bool>)delegate { return ReleaseSecurityVerifier.RefreshOnline(releaseSecurity); });
                    if (refreshed) return;
                    TimeSpan delay = ReleaseSecurityVerifier.CapDegradedRetryDelay(
                        releaseSecurity.VerifiedAtUtc,
                        DateTimeOffset.UtcNow,
                        TimeSpan.FromSeconds(delaySeconds));
                    TimeSpan monotonicRemaining = releaseSecurity.RemainingDegradedLifetime(DateTimeOffset.UtcNow);
                    if (delay > monotonicRemaining) delay = monotonicRemaining;
                    await Task.Delay(delay, onlineRefreshCancellation.Token);
                    delaySeconds = Math.Min(delaySeconds * 4, 1800);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception error)
            {
                if (!IsDisposed) ShowFatal("Arcane publisher verification failed", error.ToString());
            }
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

        private static void TryOpenExternalUri(string value)
        {
            if (!Program.AllowExternalOpen) return;
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri)
                || !String.Equals(uri.Scheme, "mailto", StringComparison.OrdinalIgnoreCase)) return;
            try
            {
                ProcessStartInfo start = new ProcessStartInfo(uri.AbsoluteUri);
                start.UseShellExecute = true;
                Process.Start(start);
            }
            catch { }
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
            SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged;
            StartupBackdrop.CloseSafely(startupBackdrop);
            startupBackdrop = null;
            try { onlineRefreshCancellation.Cancel(); } catch { }
            try { if (watchdogHeartbeatTimer != null) { watchdogHeartbeatTimer.Stop(); watchdogHeartbeatTimer.Dispose(); } } catch { }
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
        private const int PendingMessageFrameLimit = 256;
        private const int PendingMessageByteLimit = 16 * 1024 * 1024;
        private readonly Process process;
        private readonly Stream input;
        private readonly SemaphoreSlim writeLock = new SemaphoreSlim(1, 1);
        private readonly object messageLock = new object();
        private readonly Queue<string> pendingMessages = new Queue<string>();
        private Action<string> messageReceived;
        private int pendingMessageBytes;
        private bool drainingMessages;
        private bool disposed;

        public event Action<string> MessageReceived
        {
            add
            {
                if (value == null) return;
                bool drain;
                lock (messageLock)
                {
                    messageReceived += value;
                    drain = pendingMessages.Count > 0 && !drainingMessages;
                    if (drain) drainingMessages = true;
                }
                if (drain) DrainMessages();
            }
            remove
            {
                lock (messageLock) messageReceived -= value;
            }
        }
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
            if (!releaseSecurity.IsUnsignedLocalTest)
            {
                start.EnvironmentVariables["ARCANE_RELEASE_CONTENT_BINDING"] = releaseSecurity.ContentBinding;
                start.EnvironmentVariables["ARCANE_RELEASE_SIGNER_THUMBPRINT"] = releaseSecurity.SignerThumbprint;
                start.EnvironmentVariables["ARCANE_RELEASE_VERIFIED_AT"] = releaseSecurity.VerifiedAtUtc;
                start.EnvironmentVariables["ARCANE_RELEASE_REVOCATION_STATUS"] = releaseSecurity.RevocationStatus;
                start.EnvironmentVariables["ARCANE_RELEASE_TRUST_SOURCE"] = releaseSecurity.PublisherTrustSource;
                start.EnvironmentVariables["ARCANE_RELEASE_TIMESTAMP_VERIFIED"] = releaseSecurity.TimestampVerified ? "1" : "0";
            }
            Process child = Process.Start(start);
            if (child == null) throw new InvalidOperationException("Microsoft NT did not start Arcane Core.");
            return new ArcaneCoreProcess(child);
        }

        private static string BuildArguments(string bundleRoot, string appMode, string[] hostArgs, ReleaseSecurityResult releaseSecurity)
        {
            StringBuilder result = new StringBuilder();
            result.Append("--app=").Append(Quote(appMode)).Append(" --bundle-root=").Append(Quote(bundleRoot));
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
                    PublishMessage(json);
                }
            }
            catch (Exception error)
            {
                if (!disposed && Failed != null) Failed("Arcane IPC failed: " + error.Message);
            }
        }

        private void PublishMessage(string json)
        {
            bool drain;
            lock (messageLock)
            {
                int bytes = Encoding.UTF8.GetByteCount(json ?? "");
                if (pendingMessages.Count >= PendingMessageFrameLimit
                    || bytes > PendingMessageByteLimit - pendingMessageBytes)
                    throw new InvalidDataException("Arcane Core emitted too many messages before the native host could deliver them.");
                pendingMessages.Enqueue(json);
                pendingMessageBytes += bytes;
                drain = messageReceived != null && !drainingMessages;
                if (drain) drainingMessages = true;
            }
            if (drain) DrainMessages();
        }

        private void DrainMessages()
        {
            while (true)
            {
                Action<string> handler;
                string json;
                lock (messageLock)
                {
                    handler = messageReceived;
                    if (handler == null || pendingMessages.Count == 0)
                    {
                        drainingMessages = false;
                        return;
                    }
                    json = pendingMessages.Dequeue();
                    pendingMessageBytes -= Encoding.UTF8.GetByteCount(json ?? "");
                }
                try
                {
                    handler(json);
                }
                catch
                {
                    lock (messageLock) drainingMessages = false;
                    throw;
                }
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
