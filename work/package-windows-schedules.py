from pathlib import Path
import zipfile
root=Path('/Users/rogan/.gemini/antigravity/scratch/my-codex/work/windows-recurring-schedules-patch')
out=Path('/Users/rogan/.gemini/antigravity/scratch/my-codex/work/OnlyChat_Windows_Recurring_Schedules_Patch.zip')
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=7) as z:
    for p in sorted(root.iterdir()):
        if p.is_file(): z.write(p, f'onlychat-recurring-schedules-patch/{p.name}')
print(out)
