; FLYBOX virtual camera filter registration (OBS-style regsvr32).
; Installer is typically elevated for per-machine; per-user may fail silently
; and the in-app "安装设备" path still works via UAC.

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$INSTDIR\resources\vcam\flybox-virtualcam-module64.dll"
    DetailPrint "Registering FLYBOX Camera..."
    ExecWait 'regsvr32 /s /i "$INSTDIR\resources\vcam\flybox-virtualcam-module64.dll"' $0
    DetailPrint "regsvr32 install exit: $0"
  ${ElseIf} ${FileExists} "$INSTDIR\flybox-virtualcam-module64.dll"
    DetailPrint "Registering FLYBOX Camera (exe dir)..."
    ExecWait 'regsvr32 /s /i "$INSTDIR\flybox-virtualcam-module64.dll"' $0
    DetailPrint "regsvr32 install exit: $0"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} ${FileExists} "$INSTDIR\resources\vcam\flybox-virtualcam-module64.dll"
    DetailPrint "Unregistering FLYBOX Camera..."
    ExecWait 'regsvr32 /s /u "$INSTDIR\resources\vcam\flybox-virtualcam-module64.dll"' $0
  ${ElseIf} ${FileExists} "$INSTDIR\flybox-virtualcam-module64.dll"
    DetailPrint "Unregistering FLYBOX Camera (exe dir)..."
    ExecWait 'regsvr32 /s /u "$INSTDIR\flybox-virtualcam-module64.dll"' $0
  ${EndIf}
!macroend
