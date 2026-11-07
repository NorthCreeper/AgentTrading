using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Windows-subsystem task host: no console for either host or Node. The job
// closes the entire child tree if Task Scheduler terminates this host.
internal static class HeadlessHost
{
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessTime, PerJobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();

    static int Main(string[] args)
    {
        if(args.Length != 4) return 64;
        IntPtr job=IntPtr.Zero;
        Process child=null;
        string prefix=Path.GetFullPath(args[3]);
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(prefix));
            job=CreateJobObject(IntPtr.Zero, null);
            if(job==IntPtr.Zero) throw new Win32Exception();
            var limits=new ExtendedLimits(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE
            if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits))) throw new Win32Exception();
            using(var output=new StreamWriter(prefix+".out.log",true,new UTF8Encoding(false)))
            using(var error=new StreamWriter(prefix+".err.log",true,new UTF8Encoding(false))) {
                output.AutoFlush=true; error.AutoFlush=true;
                child=new Process();
                child.StartInfo=new ProcessStartInfo {
                    FileName=Path.GetFullPath(args[0]),
                    Arguments="\""+Path.GetFullPath(args[1])+"\"",
                    WorkingDirectory=Path.GetFullPath(args[2]),
                    UseShellExecute=false, CreateNoWindow=true,
                    RedirectStandardOutput=true, RedirectStandardError=true,
                    StandardOutputEncoding=Encoding.UTF8, StandardErrorEncoding=Encoding.UTF8
                };
                child.OutputDataReceived+=(sender,e)=>{if(e.Data!=null)output.WriteLine(e.Data);};
                child.ErrorDataReceived+=(sender,e)=>{if(e.Data!=null)error.WriteLine(e.Data);};
                child.Start();
                if(!AssignProcessToJobObject(job,child.Handle)) throw new Win32Exception();
                File.AppendAllText(prefix+".host.log",DateTimeOffset.Now.ToString("o")+
                    " host="+Process.GetCurrentProcess().Id+" child="+child.Id+
                    " console="+GetConsoleWindow().ToInt64()+" createNoWindow=true jobAssigned=true\r\n");
                child.BeginOutputReadLine(); child.BeginErrorReadLine();
                child.WaitForExit();
                int result=child.ExitCode;
                File.AppendAllText(prefix+".host.log",DateTimeOffset.Now.ToString("o")+" childExit="+result+"\r\n");
                return result;
            }
        } catch(Exception error) {
            try {File.AppendAllText(prefix+".host.log",DateTimeOffset.Now.ToString("o")+" error="+error+"\r\n");}catch{}
            try {if(child!=null && !child.HasExited)child.Kill();}catch{}
            return 1;
        } finally {
            if(job!=IntPtr.Zero)CloseHandle(job);
            if(child!=null)child.Dispose();
        }
    }
}
