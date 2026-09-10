; installer.iss - builds a single shareable DSH-Launcher-Setup.exe
; Compile with: iscc installer.iss   (or run build.ps1, which does everything)

#define AppName    "DSH Launcher"
#define AppVersion "0.1.2"
#define AppPublish "Mohamed"
#define ExeName    "DSHLauncher.exe"

[Setup]
AppId={{8E5C1A42-9D3B-4F7E-A6C1-2B4D8F0E5A93}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublish}
VersionInfoVersion={#AppVersion}

; Per-user install: no UAC prompt, so anyone you send this to can just run it.
PrivilegesRequired=lowest
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto

OutputDir=dist
OutputBaseFilename=DSH-Launcher-Setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\{#ExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "build\{#ExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "icon.ico";         DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}";        Filename: "{app}\{#ExeName}"; IconFilename: "{app}\icon.ico"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}";  Filename: "{app}\{#ExeName}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Run]
; No post-install launch. The dsh profile bootstrap (which shells out to pnpm)
; fails when the app is started as a child of the installer, so the first launch
; must come from the shortcut instead.

[UninstallDelete]
; The harness runtime and Edge profile live outside {app}; clean them up too.
Type: filesandordirs; Name: "{localappdata}\DeepSeekHarness"

[Code]

function NodePresent: Boolean;
begin
  // Check install locations on disk, not 'where node': PATH inside this
  // installer process is fixed when it starts, so a just-installed Node.js
  // would look "missing" even though it is already on disk. Also note the
  // installer is a 32-bit process, so {pf} would wrongly point at Program
  // Files (x86): machine-scope Node lives under {pf64}.
  Result := FileExists(ExpandConstant('{pf64}\nodejs\node.exe')) or
            FileExists(ExpandConstant('{pf}\nodejs\node.exe')) or
            FileExists(ExpandConstant('{localappdata}\Programs\nodejs\node.exe')) or
            FileExists(ExpandConstant('{userpf}\nodejs\node.exe'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep <> ssPostInstall then Exit;
  if NodePresent then Exit;

  // Node.js is provisioned by the launcher itself on first run: it installs
  // the LTS build when it is missing, verifies it by file path and puts it on
  // PATH for the npm build steps. Doing it here as well duplicated the work
  // and, when winget failed in this low-privilege installer context, only
  // produced a confusing "still could not be found" message.
  MsgBox('Node.js was not found on this PC.' + #13#10#13#10 +
         'DSH Launcher will install it automatically the first time you start it.',
         mbInformation, MB_OK);
end;
