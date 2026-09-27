# winget manifests

Mirror of what gets submitted to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)
(same folder layout under `manifests/`). Users install with:

```powershell
winget install yon
```

Only valid once the matching GitHub release is **published** (draft download
URLs don't work) and the installer hash matches `SHA256SUMS.txt` of that release.

Validate on Windows before submitting:

```powershell
winget validate --manifest packaging\winget\manifests\v\VacTuzX-dot\Yon\0.1.1
```
