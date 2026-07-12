using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
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

            try
            {
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
                Application.Run(new ArcaneForm(args));
            }
            catch (Exception error)
            {
                if (AppMode == "shell") EmergencyDesktop.TryStart();
                MessageBox.Show(error.ToString(), "Arcane could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally { GC.KeepAlive(instanceMutex); }
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
        private readonly WebView2 webView;
        private ArcaneCoreProcess core;
        private readonly ConcurrentQueue<string> pendingMessages = new ConcurrentQueue<string>();
        private bool webReady;

        public ArcaneForm(string[] args)
        {
            launchArgs = args ?? new string[0];
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
                string bundleRoot = LocateBundleRoot();
                string appRoot = Directory.Exists(Path.Combine(bundleRoot, "app"))
                    ? Path.Combine(bundleRoot, "app")
                    : Path.Combine(bundleRoot, "dist", "app");
                string appIndex = Path.Combine(appRoot, Program.AppMode, "index.html");
                if (!File.Exists(appIndex)) throw new FileNotFoundException("Arcane application assets are missing.", appIndex);

                core = ArcaneCoreProcess.Start(bundleRoot, Program.AppMode, launchArgs);
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
                webView.CoreWebView2.SetVirtualHostNameToFolderMapping("arcane.local", appRoot, CoreWebView2HostResourceAccessKind.DenyCors);
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
                webView.Source = new Uri("https://arcane.local/" + Program.AppMode + "/index.html");
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
#if ARCANE_TARGET_APP
            foreach (string allowedPath in Program.AllowedNavigationPaths)
                if (String.Equals(uri.AbsolutePath, allowedPath, StringComparison.Ordinal)) return true;
            return false;
#else
            return String.Equals(uri.AbsolutePath, "/" + Program.AppMode + "/index.html", StringComparison.Ordinal);
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

        private string LocateBundleRoot()
        {
            string exe = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string parent = Directory.GetParent(exe) == null ? null : Directory.GetParent(exe).FullName;
            string[] candidates = new string[]
            {
                parent,
                exe
            };
            foreach (string candidate in candidates)
            {
                if (String.IsNullOrWhiteSpace(candidate)) continue;
                bool hasManifest = File.Exists(Path.Combine(candidate, "arcane-bundle.json"));
                bool hasApp = Directory.Exists(Path.Combine(candidate, "app")) || Directory.Exists(Path.Combine(candidate, "dist", "app"));
                if (hasManifest && hasApp) return Path.GetFullPath(candidate);
            }
            throw new DirectoryNotFoundException("Arcane could not find arcane-bundle.json and the app payload beside the executable.");
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

        public static ArcaneCoreProcess Start(string bundleRoot, string appMode, string[] hostArgs)
        {
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            string packaged = Path.Combine(directory, "ArcaneCore.exe");
            if (!File.Exists(packaged)) throw new FileNotFoundException("ArcaneCore.exe is missing from this release.", packaged);
            string fileName = packaged;
            string arguments = BuildArguments(bundleRoot, appMode, hostArgs);

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
            Process child = Process.Start(start);
            if (child == null) throw new InvalidOperationException("Windows did not start Arcane Core.");
            return new ArcaneCoreProcess(child);
        }

        private static string BuildArguments(string bundleRoot, string appMode, string[] hostArgs)
        {
            StringBuilder result = new StringBuilder();
            result.Append("--app=").Append(Quote(appMode)).Append(" --bundle-root=").Append(Quote(bundleRoot));
            foreach (string arg in hostArgs ?? new string[0])
            {
                if (arg == "--simulate"
                    || arg == "--allow-unsigned-local-release"
                    || arg.StartsWith("--simulate-platform=", StringComparison.OrdinalIgnoreCase))
                    result.Append(' ').Append(Quote(arg));
            }
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
