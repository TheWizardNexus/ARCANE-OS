using System;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace ArcaneOS
{
    internal static class ArcanePipeGuard
    {
        private const string PipePrefix = "arcane-privileged-";
        private const int BufferSize = 64 * 1024;
        private const int MaximumRejectedClients = 32;
        private const uint ProcessQueryLimitedInformation = 0x1000;
        private const uint Synchronize = 0x00100000;
        private const uint WaitTimeout = 0x00000102;

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetNamedPipeClientProcessId(
            SafePipeHandle pipe,
            out uint clientProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        private static int Main(string[] args)
        {
            try
            {
                string pipeName = ReadPipeName(args);
                PipeSecurity security = CreatePipeSecurity();

                // The server exists before UAC is requested, so the elevated worker can
                // connect immediately. No application bytes are accepted until the
                // broker supplies the exact PID returned by Start-Process -PassThru.
                NamedPipeServerStream server = CreateServer(pipeName, security);
                WriteSignal("ARCANE_PIPE_GUARD_READY " + pipeName);
                Stream standardInput = Console.OpenStandardInput();
                uint expectedPid = ReadExpectedPid(standardInput);
                IntPtr expectedProcess = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, expectedPid);
                if (expectedProcess == IntPtr.Zero)
                {
                    throw new InvalidOperationException(
                        "The expected worker process could not be opened (Windows error " +
                        Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ").");
                }
                try
                {
                    if (WaitForSingleObject(expectedProcess, 0) != WaitTimeout)
                    {
                        throw new InvalidOperationException("The expected worker process exited before pipe authentication.");
                    }

                    // Holding this process handle keeps the kernel process object alive,
                    // preventing the expected PID from being recycled before binding.
                    int rejected = 0;
                    while (true)
                    {
                        using (server)
                        {
                            WaitForConnectionOrProcessExit(server, expectedProcess, expectedPid);
                            uint clientPid;
                            if (!GetNamedPipeClientProcessId(server.SafePipeHandle, out clientPid))
                            {
                                throw new InvalidOperationException(
                                    "GetNamedPipeClientProcessId failed with Windows error " +
                                    Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ".");
                            }

                            if (clientPid != expectedPid)
                            {
                                rejected++;
                                WriteSignal("ARCANE_PIPE_GUARD_REJECTED " + clientPid.ToString(CultureInfo.InvariantCulture));
                                if (rejected >= MaximumRejectedClients)
                                {
                                    throw new InvalidOperationException("Too many named-pipe clients failed kernel PID verification.");
                                }
                            }
                            else
                            {
                                if (WaitForSingleObject(expectedProcess, 0) != WaitTimeout)
                                {
                                    throw new InvalidOperationException("The expected worker process exited during pipe authentication.");
                                }
                                WriteSignal("ARCANE_PIPE_GUARD_BOUND " + clientPid.ToString(CultureInfo.InvariantCulture));
                                Relay(server, standardInput, Console.OpenStandardOutput());
                                return 0;
                            }
                        }

                        server = CreateServer(pipeName, security);
                    }
                }
                finally
                {
                    CloseHandle(expectedProcess);
                }
            }
            catch (Exception error)
            {
                WriteSignal("ARCANE_PIPE_GUARD_ERROR " + Sanitize(error.Message));
                return 10;
            }
        }

        private static void WaitForConnectionOrProcessExit(
            NamedPipeServerStream server,
            IntPtr expectedProcess,
            uint expectedPid)
        {
            IAsyncResult connection = server.BeginWaitForConnection(null, null);
            using (WaitHandle connectionReady = connection.AsyncWaitHandle)
            using (ManualResetEvent processExited = new ManualResetEvent(false))
            {
                processExited.SafeWaitHandle = new SafeWaitHandle(expectedProcess, false);
                int signaled = WaitHandle.WaitAny(new WaitHandle[] { connectionReady, processExited });
                if (signaled == 1)
                {
                    uint exitCode;
                    if (!GetExitCodeProcess(expectedProcess, out exitCode))
                    {
                        int exitCodeError = Marshal.GetLastWin32Error();
                        CompleteCancelledConnectionWait(server, connection);
                        throw new InvalidOperationException(
                            "The expected worker process " + expectedPid.ToString(CultureInfo.InvariantCulture) +
                            " exited before pipe connection; Windows could not read its exit code (error " +
                            exitCodeError.ToString(CultureInfo.InvariantCulture) + ").");
                    }
                    CompleteCancelledConnectionWait(server, connection);
                    throw new InvalidOperationException(
                        "The expected worker process " + expectedPid.ToString(CultureInfo.InvariantCulture) +
                        " exited before pipe connection with exit code " +
                        exitCode.ToString(CultureInfo.InvariantCulture) + ".");
                }
                server.EndWaitForConnection(connection);
            }
        }

        private static void CompleteCancelledConnectionWait(NamedPipeServerStream server, IAsyncResult connection)
        {
            server.Dispose();
            try
            {
                server.EndWaitForConnection(connection);
            }
            catch (ObjectDisposedException)
            {
            }
            catch (IOException)
            {
            }
        }

        private static string ReadPipeName(string[] args)
        {
            const string option = "--pipe-name=";
            string value = null;
            foreach (string argument in args)
            {
                if (argument != null && argument.StartsWith(option, StringComparison.Ordinal))
                {
                    if (value != null) throw new ArgumentException("The pipe name was supplied more than once.");
                    value = argument.Substring(option.Length);
                }
                else
                {
                    throw new ArgumentException("ArcanePipeGuard accepts only --pipe-name.");
                }
            }

            if (String.IsNullOrEmpty(value) || value.Length > 180 || !value.StartsWith(PipePrefix, StringComparison.Ordinal))
            {
                throw new ArgumentException("The Arcane named-pipe name is invalid.");
            }
            foreach (char character in value)
            {
                bool allowed = character >= 'a' && character <= 'z'
                    || character >= 'A' && character <= 'Z'
                    || character >= '0' && character <= '9'
                    || character == '-';
                if (!allowed) throw new ArgumentException("The Arcane named-pipe name contains an invalid character.");
            }
            return value;
        }

        private static uint ReadExpectedPid(Stream input)
        {
            const string prefix = "ARCANE_EXPECTED_PID ";
            MemoryStream line = new MemoryStream();
            while (line.Length <= 64)
            {
                int next = input.ReadByte();
                if (next < 0) throw new EndOfStreamException("The broker closed before supplying the expected worker PID.");
                if (next == '\n') break;
                if (next == '\r') continue;
                if (next < 0x20 || next > 0x7e) throw new InvalidDataException("The expected PID control line is not ASCII.");
                line.WriteByte((byte)next);
            }
            if (line.Length > 64) throw new InvalidDataException("The expected PID control line is too long.");
            string text = Encoding.ASCII.GetString(line.ToArray());
            if (!text.StartsWith(prefix, StringComparison.Ordinal)) throw new InvalidDataException("The expected PID control line is invalid.");
            uint pid;
            if (!UInt32.TryParse(text.Substring(prefix.Length), NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid == 0)
            {
                throw new InvalidDataException("The expected worker PID is invalid.");
            }
            return pid;
        }

        private static PipeSecurity CreatePipeSecurity()
        {
            WindowsIdentity identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query);
            if (identity.User == null) throw new InvalidOperationException("The broker Windows identity has no user SID.");

            PipeSecurity security = new PipeSecurity();
            security.SetAccessRuleProtection(true, false);
            security.SetOwner(identity.User);
            security.AddAccessRule(new PipeAccessRule(identity.User, PipeAccessRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                PipeAccessRights.FullControl,
                AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                PipeAccessRights.FullControl,
                AccessControlType.Allow));
            return security;
        }

        private static NamedPipeServerStream CreateServer(string pipeName, PipeSecurity security)
        {
            return new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.WriteThrough,
                BufferSize,
                BufferSize,
                security);
        }

        private static void Relay(NamedPipeServerStream pipe, Stream input, Stream output)
        {
            Task upload = CopyAsync(input, pipe);
            upload.ContinueWith(delegate(Task task)
            {
                try { pipe.Close(); } catch { }
            }, TaskContinuationOptions.OnlyOnFaulted);

            try
            {
                CopyAsync(pipe, output).Wait();
            }
            catch (AggregateException aggregate)
            {
                throw aggregate.InnerException ?? aggregate;
            }
        }

        private static async Task CopyAsync(Stream source, Stream destination)
        {
            byte[] buffer = new byte[BufferSize];
            while (true)
            {
                int count = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                if (count == 0) return;
                await destination.WriteAsync(buffer, 0, count).ConfigureAwait(false);
                await destination.FlushAsync().ConfigureAwait(false);
            }
        }

        private static string Sanitize(string value)
        {
            return String.IsNullOrEmpty(value)
                ? "Unknown failure."
                : value.Replace('\r', ' ').Replace('\n', ' ');
        }

        private static void WriteSignal(string message)
        {
            Console.Error.WriteLine(message);
            Console.Error.Flush();
        }
    }
}
