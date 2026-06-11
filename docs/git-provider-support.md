# Git Provider Support

Workspace-to-repository linking via Bifrost supports both **GitHub** and **GitLab** (cloud and self-hosted) repository URLs. The `repo-url` value (or the auto-derived URL from CI environment variables) is stored as-is by Bifrost without provider-specific validation. URL normalization handles HTTPS, SSH (`git@`), and `.git` suffix variants for both providers.
