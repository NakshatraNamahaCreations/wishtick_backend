' Wishtick — start the local development MongoDB at logon.
'
' Runs a single-node replica set (transactions are required by the app) hidden,
' with no console window, so the backend always has a database ready — the same
' way Redis already runs as a Windows service on this machine.
'
' A second launch while one is already listening just exits (port 27017 in use),
' so this is safe to run repeatedly. To disable persistence, delete the copy of
' this file from the Startup folder:
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\wishtick-mongo.vbs
Set sh = CreateObject("WScript.Shell")
sh.Run """D:\Jayanth\Wishtick\wishtick_backend\.dev-mongo\mongod.exe"" --replSet rs0 --port 27017 --dbpath ""D:\Jayanth\Wishtick\wishtick_backend\.dev-mongo-data"" --bind_ip 127.0.0.1", 0, False
