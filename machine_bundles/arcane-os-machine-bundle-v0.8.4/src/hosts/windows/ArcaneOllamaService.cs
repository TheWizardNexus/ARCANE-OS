using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace ArcaneOS
{
    internal static class OllamaServiceProgram
    {
        private const string ServiceNameValue = "ArcaneOllama";

        public static int Main(string[] args)
        {
            try
            {
                if (args.Length == 1 && String.Equals(args[0], "--probe", StringComparison.Ordinal))
                    return Probe();
                if (args.Length != 0 && !(args.Length == 1 && String.Equals(args[0], "--service", StringComparison.Ordinal)))
                {
                    Console.Error.WriteLine("Usage: ArcaneOllamaService.exe --service|--probe");
                    return 64;
                }
                ServiceBase.Run(new ArcaneOllamaService());
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.ToString());
                return 1;
            }
        }

        private static int Probe()
        {
            string executable = ArcaneOllamaService.OllamaExecutablePath;
            if (!ArcaneOllamaService.IsRegularFile(executable))
            {
                Console.Error.WriteLine("Ollama executable is missing or is a reparse point: " + executable);
                return 2;
            }
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:11434/api/version");
                request.Method = "GET";
                request.Timeout = 3000;
                request.ReadWriteTimeout = 3000;
                request.Proxy = null;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (Stream stream = response.GetResponseStream())
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true, 1024, false))
                {
                    string body = reader.ReadToEnd();
                    if ((int)response.StatusCode < 200 || (int)response.StatusCode >= 300 || body.Length == 0)
                        throw new InvalidDataException("Ollama returned an invalid health response.");
                    Console.WriteLine("{\"service\":\"" + ServiceNameValue + "\",\"ready\":true,\"endpoint\":\"http://127.0.0.1:11434\"}");
                    return 0;
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("Ollama health probe failed: " + error.Message);
                return 3;
            }
        }
    }

    internal sealed class ArcaneOllamaService : ServiceBase
    {
        private const string EventSource = "ArcaneOllama";
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private readonly object gate = new object();
        private readonly BoundedText stdout = new BoundedText(8192);
        private readonly BoundedText stderr = new BoundedText(8192);
        private Process child;
        private IntPtr job = IntPtr.Zero;
        private bool stopping;

        internal static string OllamaExecutablePath
        {
            get { return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ollama.exe"); }
        }

        internal ArcaneOllamaService()
        {
            ServiceName = "ArcaneOllama";
            CanStop = true;
            CanShutdown = true;
            AutoLog = false;
        }

        protected override void OnStart(string[] args)
        {
            WriteEvent("ArcaneOllama service host entered startup.", EventLogEntryType.Information);
            string executable = OllamaExecutablePath;
            if (!IsRegularFile(executable)) throw new InvalidDataException("The sibling ollama.exe is missing or is a reparse point.");
            IntPtr newJob = CreateKillOnCloseJob();
            Process process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = executable,
                Arguments = "serve",
                WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            process.EnableRaisingEvents = true;
            try
            {
                if (!process.Start()) throw new InvalidOperationException("Windows did not start ollama.exe.");
                if (!AssignProcessToJobObject(newJob, process.Handle))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Windows could not bind Ollama to its kill-on-close job object.");
                BeginDrain(process.StandardOutput, stdout);
                BeginDrain(process.StandardError, stderr);
                if (process.WaitForExit(1500)) throw new InvalidOperationException("ollama.exe exited during service startup with code " + process.ExitCode + ".");
                lock (gate)
                {
                    child = process;
                    job = newJob;
                }
                newJob = IntPtr.Zero;
                process.Exited += ChildExited;
                if (process.HasExited) throw new InvalidOperationException("ollama.exe exited while the service was completing startup.");
                WriteEvent("ArcaneOllama started ollama.exe serve under a kill-on-close job object.", EventLogEntryType.Information);
            }
            catch
            {
                process.Exited -= ChildExited;
                try { if (!process.HasExited) process.Kill(); } catch { }
                process.Dispose();
                throw;
            }
            finally
            {
                if (newJob != IntPtr.Zero) CloseHandle(newJob);
            }
        }

        protected override void OnStop()
        {
            StopChild("service stop");
        }

        protected override void OnShutdown()
        {
            StopChild("system shutdown");
            base.OnShutdown();
        }

        private void StopChild(string reason)
        {
            Process process;
            IntPtr ownedJob;
            lock (gate)
            {
                stopping = true;
                process = child;
                child = null;
                ownedJob = job;
                job = IntPtr.Zero;
            }
            if (process != null) process.Exited -= ChildExited;
            if (ownedJob != IntPtr.Zero)
            {
                TerminateJobObject(ownedJob, 0);
                CloseHandle(ownedJob);
            }
            if (process != null)
            {
                try { process.WaitForExit(10000); } catch { }
                process.Dispose();
            }
            WriteEvent("ArcaneOllama stopped Ollama for " + reason + ".", EventLogEntryType.Information);
        }

        private void ChildExited(object sender, EventArgs args)
        {
            Process process = sender as Process;
            bool expected;
            int exitCode = -1;
            lock (gate) expected = stopping;
            try { if (process != null) exitCode = process.ExitCode; } catch { }
            if (expected) return;
            string message = "ollama.exe exited unexpectedly with code " + exitCode + ".";
            string capturedOut = stdout.ToString();
            string capturedError = stderr.ToString();
            if (capturedOut.Length != 0) message += Environment.NewLine + "Last stdout:" + Environment.NewLine + capturedOut;
            if (capturedError.Length != 0) message += Environment.NewLine + "Last stderr:" + Environment.NewLine + capturedError;
            WriteEvent(message, EventLogEntryType.Error);
            Environment.Exit(exitCode == 0 ? 1 : exitCode);
        }

        private static void BeginDrain(StreamReader reader, BoundedText destination)
        {
            Thread thread = new Thread(delegate()
            {
                try
                {
                    char[] buffer = new char[1024];
                    int count;
                    while ((count = reader.Read(buffer, 0, buffer.Length)) > 0) destination.Append(buffer, count);
                }
                catch { }
            });
            thread.IsBackground = true;
            thread.Name = "ArcaneOllama output drain";
            thread.Start();
        }

        internal static bool IsRegularFile(string file)
        {
            try
            {
                FileAttributes attributes = File.GetAttributes(file);
                return (attributes & FileAttributes.Directory) == 0 && (attributes & FileAttributes.ReparsePoint) == 0;
            }
            catch { return false; }
        }

        private static IntPtr CreateKillOnCloseJob()
        {
            IntPtr handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Windows could not create the Ollama job object.");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr pointer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(information, pointer, false);
                if (!SetInformationJobObject(handle, 9, pointer, (uint)size))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Windows could not configure the Ollama job object.");
                return handle;
            }
            catch
            {
                CloseHandle(handle);
                throw;
            }
            finally { Marshal.FreeHGlobal(pointer); }
        }

        private static void WriteEvent(string message, EventLogEntryType type)
        {
            try { EventLog.WriteEntry(EventSource, message.Length > 30000 ? message.Substring(message.Length - 30000) : message, type); }
            catch { }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr information, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        private sealed class BoundedText
        {
            private readonly int maximum;
            private readonly Queue<char> characters = new Queue<char>();
            private readonly object sync = new object();

            internal BoundedText(int maximumLength) { maximum = maximumLength; }

            internal void Append(char[] value, int count)
            {
                lock (sync)
                {
                    for (int index = 0; index < count; index += 1)
                    {
                        characters.Enqueue(value[index]);
                        while (characters.Count > maximum) characters.Dequeue();
                    }
                }
            }

            public override string ToString()
            {
                lock (sync) return new string(characters.ToArray());
            }
        }
    }
}
