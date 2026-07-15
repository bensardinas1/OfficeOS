' start-daemon-hidden.vbs — run the daemon with NO console window.
' Task Scheduler shows a visible console for a console app in an interactive
' session; users close that window and unknowingly SIGINT the daemon (clean
' exit 0 = no restart). wscript.exe is a windowless host: it launches node
' hidden (window style 0), WAITS for it, and exits with node's exit code so
' the task's restart-on-failure policy still sees crashes.
'
' Arguments: 0 = repo root (working directory), 1 = full path to node.exe
Dim sh, code
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = WScript.Arguments(0)
code = sh.Run("""" & WScript.Arguments(1) & """ daemon\daemon.js", 0, True)
WScript.Quit code
