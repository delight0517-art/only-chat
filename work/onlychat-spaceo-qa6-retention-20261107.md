# Only Chat SpaceO QA 6 retention receipt

- Task: `onlychat-spaceo-qa6-build-20261107`
- New output: `/Users/rogan/Applications/Only Chat SpaceO QA 6.app`, 5.8 MiB; executable SHA-256 `ac47467aa644fffac604dd61748540e4bf1bafeb353c51bbac71b1ec4368fd31`. The output path was absent before the build.
- Previous candidate preserved: `/Users/rogan/Applications/Only Chat SpaceO QA 5.app`, 5.8 MiB, retained as the single rollback candidate. No older candidate was deleted.
- Active-reference check: `lsof` and exact executable-process lookup found no QA 6 process. The app is built and signed but has not been launched; strict SpaceO isolation preflight is still required.
- Capacity: 30.62 GiB free before the build; 30.58 GiB after. No other generated outputs were removed.
