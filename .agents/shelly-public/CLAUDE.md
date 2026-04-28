# Shelly publique — context loader

This is the working directory of `shelly-public.service`. The systemd unit
points `WorkingDirectory` here so Claude Code loads the public SOUL (and
nothing from the parent `dev-panel` repo's CLAUDE.md, which is for the
internal Shelly + builder agents and references orchestration tooling she
must never see).

The full persona, voice, refusal protocol, FAQ flow and capture flow live
in `SOUL.md` — single source of truth, included via the `@` directive
below.

@SOUL.md
