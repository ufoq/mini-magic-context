# Shown on each interactive shell in the setup sandbox. Sourced from .bashrc.
cat <<'BANNER'

  Magic Context: setup/doctor sandbox  (published @latest)
  =========================================================
  Project:  /test/project   (git repo)

  OpenCode setup:   mini-magic-context setup --harness opencode
  Pi setup:         mini-magic-context setup --harness pi
  Doctor:           mini-magic-context doctor --harness opencode
                    mini-magic-context doctor --harness pi
  Non-interactive:  mini-magic-context doctor --harness opencode --force

  Verify the new CortexKit config location after setup:
    cat ~/.config/cortexkit/mini-magic-context.jsonc          # user config
    cat /test/project/.cortexkit/mini-magic-context.jsonc      # project config
    ls -la ~/.local/share/cortexkit/mini-magic-context/        # shared DB + models
    cat ~/.config/opencode/opencode.json                  # plugin registration
    cat ~/.pi/agent/settings.json                          # pi extension reg.

  Versions:  mini-magic-context --version ; opencode --version ; pi --version

BANNER
