# Team repository and collaboration

Local project root: ~/Desktop/CloudComputing/Team Project

Configured remotes:
- origin: git@github.com:ApriCuz54/CS6620-Fall2026-Team5-Project.git (team repository)
- upstream: git@github.com:aanchan/cs6620.git (instructor source)

SSH read access to the team remote was verified; no refs were listed at setup time. No project setup changes have been committed or pushed. Existing course history is retained locally. Confirm invitations for Arvind Dharmesh Parekh and Chengyuan Sun in GitHub Settings → Collaborators.

Before committing, review the proposed file list and changes with Aditya. No commit or push should happen until he authorizes it. Never include .env, credentials, private keys, Terraform state, saved plans, backend.hcl or local backups. Ignore rules do not untrack the node_modules directories included in the instructor's repository; review those separately to avoid dependency churn.

After the first approved foundation commit is published, teammates clone the team origin. Arvind and Chengyuan should branch from the merged working-foundation commit after the handoff. Workflow/client and worker changes use separate paths; shared contracts need review together. Keep upstream for course updates.

Do not enable the final required security check before its workflow exists and has run. Setup tests are not the final security merge gate.
