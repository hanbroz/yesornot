param(
    [Parameter(Mandatory=$true)][string]$ExecutablePath,
    [Parameter(Mandatory=$true)][string]$IconPath
)
$ErrorActionPreference = 'Stop'
$exeFile = (Resolve-Path -LiteralPath $ExecutablePath).Path
$icoFile = (Resolve-Path -LiteralPath $IconPath).Path
if ([IO.Path]::GetExtension($exeFile) -ne '.exe' -or [IO.Path]::GetExtension($icoFile) -ne '.ico') {
    throw 'Expected an EXE target and an ICO source.'
}
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AppIconResource {
    private delegate bool EnumName(IntPtr module, IntPtr type, IntPtr name, IntPtr extra);
    private delegate bool EnumLanguage(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr extra);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll")] private static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumName callback, IntPtr extra);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLanguage callback, IntPtr extra);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool EndUpdateResource(IntPtr update, bool discard);
    private sealed class Existing { public int Type; public int Id; public string Name; public ushort Language; }
    private static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }

    public static void Apply(string exe, string ico) {
        byte[] source = File.ReadAllBytes(ico);
        if (source.Length < 6 || BitConverter.ToUInt16(source,0) != 0 || BitConverter.ToUInt16(source,2) != 1) throw new InvalidDataException("Invalid ICO header.");
        int count = BitConverter.ToUInt16(source,4);
        if (count < 1 || count > 64 || source.Length < 6 + 16 * count) throw new InvalidDataException("Invalid ICO directory.");
        var images = new List<byte[]>();
        var groupStream = new MemoryStream();
        var writer = new BinaryWriter(groupStream);
        writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)count);
        for (int i=0; i<count; i++) {
            int entry = 6 + 16 * i;
            uint size = BitConverter.ToUInt32(source,entry+8);
            uint offset = BitConverter.ToUInt32(source,entry+12);
            if (size == 0 || size > int.MaxValue || offset < 6 + 16 * count || (ulong)offset + size > (ulong)source.Length) throw new InvalidDataException("Invalid ICO image bounds.");
            byte[] data = new byte[(int)size];
            Buffer.BlockCopy(source,(int)offset,data,0,data.Length);
            images.Add(data);
            writer.Write(source,entry,12); writer.Write((ushort)(i+1));
        }
        writer.Flush(); byte[] group = groupStream.ToArray(); writer.Dispose();
        var existing = new List<Existing>();
        IntPtr module = LoadLibraryEx(exe,IntPtr.Zero,0x22);
        if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            foreach (int type in new int[] {3,14}) {
                EnumName names = delegate(IntPtr m, IntPtr t, IntPtr n, IntPtr extra) {
                    long value = n.ToInt64(); bool numeric = (value >> 16) == 0;
                    string name = numeric ? null : Marshal.PtrToStringUni(n);
                    EnumLanguage languages = delegate(IntPtr lm, IntPtr lt, IntPtr ln, ushort language, IntPtr le) {
                        existing.Add(new Existing { Type=type, Id=numeric ? (int)value : 0, Name=name, Language=language }); return true;
                    };
                    return EnumResourceLanguages(m,t,n,languages,IntPtr.Zero);
                };
                if (!EnumResourceNames(module,(IntPtr)type,names,IntPtr.Zero)) {
                    int error=Marshal.GetLastWin32Error();
                    if (error != 1813 && error != 1814) throw new Win32Exception(error);
                }
            }
        } finally { FreeLibrary(module); }
        IntPtr update = BeginUpdateResource(exe,false);
        if (update == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        bool committed = false;
        try {
            foreach (Existing resource in existing) {
                IntPtr name = resource.Name == null ? (IntPtr)resource.Id : Marshal.StringToHGlobalUni(resource.Name);
                try { Check(UpdateResource(update,(IntPtr)resource.Type,name,resource.Language,null,0)); }
                finally { if (resource.Name != null) Marshal.FreeHGlobal(name); }
            }
            for (int i=0; i<images.Count; i++) Check(UpdateResource(update,(IntPtr)3,(IntPtr)(i+1),0,images[i],(uint)images[i].Length));
            Check(UpdateResource(update,(IntPtr)14,(IntPtr)1,0,group,(uint)group.Length));
            Check(EndUpdateResource(update,false)); committed = true;
        } finally { if (!committed) EndUpdateResource(update,true); }
        Console.WriteLine("Embedded application icon ({0} sizes).", count);
    }
}
'@
[AppIconResource]::Apply($exeFile, $icoFile)
