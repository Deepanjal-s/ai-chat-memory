' Runs start-memory.cmd without a console window (used at Windows sign-in).
Set shell = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
shell.Run """" & dir & "\start-memory.cmd""", 0, False
