# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-04-10

### Added
- Initial release of dev-panel
- React UI component with floating bug/feature reporting button
- SQLite database for ticket storage
- Screenshot upload and storage
- Auto-capture of context (URL, user agent, timestamp, viewport)
- GitHub integration for issue creation
- Bi-directional sync with GitHub issues
- 8 CLI commands:
  - `init` - Initialize dev-panel in project
  - `serve` - Start API server
  - `list` - List tickets with filters
  - `review` - Review ticket details (formatted for AI assistants)
  - `publish` - Publish ticket to GitHub as issue
  - `reject` - Reject ticket with reason
  - `sync` - Sync ticket status with GitHub
  - `stats` - Show ticket statistics dashboard
- Zero-config setup with auto-detection from package.json
- Multi-project support
- Comprehensive documentation

### Features
- Plug & play installation
- Lightweight SQLite storage (no external database needed)
- PM review workflow optimized for Claude Code
- Support for concurrent dev server (Vite + dev-panel)
- Automatic .gitignore updates
- Screenshot support (up to 10MB)
- Status lifecycle management (pending → published → closed)
- GitHub labels and assignees support

[1.0.0]: https://github.com/franckbirba/dev-panel/releases/tag/v1.0.0
