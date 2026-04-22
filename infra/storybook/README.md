# devpanl Storybook

Shared UI catalogue for all studio projects. Deployed as the `storybook`
service in docker-compose.yml under the [core, all] profiles; browsable at
https://ui.devpanl.dev.

Stories are NOT kept in this folder. They live in the `stories/` folder of
each consuming project's repo and are rsync'd into the shared volume
`storybook-stories` on every push to main via
`.github/workflows/sync-stories.yml`.

Run locally against this repo's `stories/` folder:

    make storybook-dev
