; ---------------------------------------------------------------------------
; Infoflex — installer vendor-authorisation gate
; ---------------------------------------------------------------------------
; electron-builder includes this file (it is picked up automatically as
; `resources/build/installer.nsh`) at the very top of the generated NSIS
; script. It adds ONE page in front of everything else:
;
;   Vendor authorisation -> [licence] -> [install mode] -> [folder] -> install
;
; The page cannot be skipped: "Next" re-verifies the password on every attempt
; and stays put when it is wrong, "Cancel" aborts the installer, and five wrong
; attempts close it. Silent (/S) installs are refused outright because there is
; no way to show the page.
;
; The password itself is never stored here. scripts/make-installer-gate.ts
; reads VENDOR_MASTER_PASSWORD, and writes generated/gate.nsh containing a random
; salt, an iteration count and the PBKDF2 digests of the password. gate.ps1
; (about 90 lines of PowerShell that ships inside the installer) recomputes the
; digest of what the user typed and compares it. Neither script, nor this file,
; nor the generated header is committed with a password in it.
; ---------------------------------------------------------------------------

!ifndef INFOFLEX_INSTALLER_NSH
!define INFOFLEX_INSTALLER_NSH

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER

  ; ---- compile-time guard: refuse to produce an installer without the gate ----
  !if /FileExists "${__FILEDIR__}\generated\gate.nsh"
    !include "${__FILEDIR__}\generated\gate.nsh"
  !else
    !error "Installer gate missing. Run `npm run installer:gate` with VENDOR_MASTER_PASSWORD set, then package again."
  !endif

  !if /FileExists "${__FILEDIR__}\gate.ps1"
  !else
    !error "resources/build/gate.ps1 is missing; the installer gate cannot work."
  !endif

  !define /ifndef GATE_MAX_ATTEMPTS 5

  Var GateAttempts
  Var GateVerified
  Var GateEdit
  Var GateHint

  ; Silent installs never reach the page, so they are not allowed at all.
  !macro preInit
    ${If} ${Silent}
      SetErrorLevel 2
      Quit
    ${EndIf}
  !macroend

  !macro customWelcomePage
    Page custom GatePageCreate GatePageLeave
  !macroend

  Function GatePageCreate
    StrCpy $GateVerified 0
    StrCmp $GateAttempts "" 0 +2
      StrCpy $GateAttempts 0

    ; Unpack the verifier into the plugin folder once, so each attempt only has
    ; to run it.
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "/oname=$PLUGINSDIR\gate.ps1" "${__FILEDIR__}\gate.ps1"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 20u "Infoflex installer authorisation"
    Pop $0

    ${NSD_CreateLabel} 0 22u 100% 30u "This installer is licensed software. Type the installer password supplied by Infoflex to continue. Five incorrect attempts will close the installer."
    Pop $0

    ${NSD_CreateLabel} 0 58u 100% 10u "Installer password:"
    Pop $0

    ${NSD_CreatePassword} 0 69u 100% 13u ""
    Pop $GateEdit
    ${NSD_SetFocus} $GateEdit

    ${NSD_CreateLabel} 0 88u 100% 22u ""
    Pop $GateHint

    nsDialogs::Show
  FunctionEnd

  Function GatePageLeave
    ; Already authorised in this session — no need to ask again.
    StrCmp $GateVerified 1 0 +2
      Return

    ${NSD_GetText} $GateEdit $0
    ${If} $0 == ""
      ${NSD_SetText} $GateHint "Type the installer password to continue, or press Cancel to close the installer."
      Abort
    ${EndIf}

    ; Hand the candidate over in an environment variable so it never appears in
    ; a process command line, then wipe it immediately after the check.
    System::Call 'kernel32::SetEnvironmentVariable(t "INFOFLEX_GATE_PASSWORD", t "$0")'
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\gate.ps1" -Salt ${GATE_SALT} -Iterations ${GATE_ITERATIONS} -Hash ${GATE_HASH_SHA256} -LegacyHash ${GATE_HASH_SHA1}'
    Pop $1 ; exit code
    Pop $2 ; stdout
    System::Call 'kernel32::SetEnvironmentVariable(t "INFOFLEX_GATE_PASSWORD", i 0)'
    StrCpy $0 ""

    ${If} $2 == "GATE_OK"
      StrCpy $GateVerified 1
      ${NSD_SetText} $GateHint ""
    ${ElseIf} $2 == "GATE_ERROR"
      ; The verifier could not run at all. Fail closed, and do not count it as
      ; a wrong password so a broken script cannot use up the customer's five
      ; attempts.
      MessageBox MB_ICONSTOP "The installer password check could not run on this computer (Windows PowerShell is required). The installer cannot continue. Please contact Infoflex."
      SetErrorLevel 2
      Quit
    ${Else}
      IntOp $GateAttempts $GateAttempts + 1
      ${If} $GateAttempts >= ${GATE_MAX_ATTEMPTS}
        MessageBox MB_ICONSTOP "The installer password was entered incorrectly ${GATE_MAX_ATTEMPTS} times. The installer will now close. Please contact Infoflex if you need the password again."
        SetErrorLevel 2
        Quit
      ${EndIf}
      ${NSD_SetText} $GateHint "Incorrect installer password — attempt $GateAttempts of ${GATE_MAX_ATTEMPTS}."
      Abort
    ${EndIf}
  FunctionEnd

!endif ; BUILD_UNINSTALLER
!endif ; INFOFLEX_INSTALLER_NSH
