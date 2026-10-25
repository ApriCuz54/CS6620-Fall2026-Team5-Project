# Team repository and collaboration

Local project root: ~/Desktop/CloudComputing/Team Project

Configured remotes:
- origin: git@github.com:ApriCuz54/CS6620-Fall2026-Team5-Project.git (team repository)
- upstream: git@github.com:aanchan/cs6620.git (instructor source)

Team remote access was verified. Reviewed setup commit 9a9597f was pushed to origin/main with Aditya’s explicit approval. The API, cloud-storage and hosted dummy foundation is published on foundation/local-api following Aditya’s authorization to proceed through the review/commit/push steps. Existing course history is retained locally. Confirm invitations for Arvind Dharmesh Parekh and Chengyuan Sun in GitHub Settings → Collaborators.

Review changes before committing. Aditya authorized publishing this foundation milestone; future work still requires authorization before committing or pushing. Never include .env, credentials, private keys, Terraform state, saved plans, backend.hcl or local backups. Ignore rules do not untrack the node_modules directories included in the instructor's repository; review those separately to avoid dependency churn.

After the first approved foundation commit is published, teammates clone the team origin. Arvind and Chengyuan should branch from the merged working-foundation commit after the handoff. Workflow/client and worker changes use separate paths; shared contracts need review together. Keep upstream for course updates.

Do not enable the final required security check before its workflow exists and has run. Setup tests are not the final security merge gate.
