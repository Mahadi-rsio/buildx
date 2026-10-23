# Graph Report - buildx  (2026-10-23)

## Corpus Check
- 422 files · ~436,490 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 58 file(s) not represented in the graph (top: .csv 53, (none) 3, .example 1)

## Summary
- 4788 nodes · 9607 edges · 213 communities (187 shown, 26 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 267 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `99349a4f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Button
- validate_data.py
- design_system.py
- github/github.test.ts
- ShadcnInstaller
- json
- scripts/core.py
- servers/[id]/route.ts
- agent/src/skills.ts
- shared/src/index.ts
- tool-row.tsx
- schema.ts
- [id]/page.tsx
- shell-context.tsx
- job-worker.ts
- getCurrentUser
- terminal.ts
- test_design_system_mode.py
- skills/store.ts
- thinking-trace.tsx
- lib/store.ts
- shell/sidebar.tsx
- Sandbox
- react
- icon/generate.py
- oauth.ts
- slide_search_core.py
- Tailwind CSS Utility Reference
- DesignSystemGenerator
- TestSandbox
- WorkspaceGit
- ui/sidebar.tsx
- TailwindConfigGenerator
- db/package.json
- lib/quota.ts
- git/route.ts
- workspace-panel.tsx
- dependencies
- agent/package.json
- tools.ts
- csv
- sandbox/src/index.ts
- BoxSandbox
- Brand Guidelines v1.0
- run-creation.ts
- ref_node_assert
- Design
- Canvas Design System
- Prerequisites
- agent/src/index.ts
- spacing
- scripts
- Form & Input Components
- Tailwind CSS Responsive Design
- unittest
- workspace-source.ts
- right-panel.tsx
- web/package.json
- Typography Specifications
- findOwnedRun
- workspace-git.tsx
- SessionHandle
- Logo Usage Rules
- Component Specifications
- html-token-validator.py
- shadcn/ui Accessibility Patterns
- sandbox/package.json
- sign-in/page.tsx
- cip/core.py
- diff-view.tsx
- Asset Approval Checklist
- Logo AI Prompt Engineering
- skills-page.tsx
- Color Palette Management
- CIP Deliverable Guide
- States and Variants
- UI Styling Skill
- Workflow
- code-viewer.tsx
- Design System
- Tailwind CSS Customization
- mcp.ts
- box-sandbox.ts
- components.json
- shared/package.json
- generate-slide.py
- buildGitHubTools
- context.ts
- Routing by Task Type
- shadcn/ui Theming & Customization
- conversation-sync.ts
- Asset Organization Guide
- Primary Color Meanings
- Core Logo Types
- gray
- color
- agent/src/skills.test.ts
- Brand Consistency Checklist
- CIP Mockup Prompt Engineering
- Color Semantics
- radius
- context-budget.ts
- BuildX
- 6. Phases
- chat-message.tsx
- storage/package.json
- ops.test.ts
- query-provider.tsx
- workspace-terminal.tsx
- Design Principles
- Design Principles
- fontSize
- test_tailwind_config_gen.py
- main
- Phase Plan — Auth + Local Postgres + Local MinIO + Fly.io Free-Tier Sandbox Lifecycle
- group-runs.ts
- CIP Design Reference
- Icon Design Reference
- Copywriting Formulas
- color
- Copywriting Formulas
- CatalogRefreshTest
- Banner Design - Multi-Format Creative Banner System
- Messaging Framework
- Brand Voice Framework
- Layout Patterns
- Tailwind Integration
- Layout Patterns
- TestWebStackFreshness
- LazyBoxSandbox
- test_style_taxonomy.py
- app/layout.tsx
- compilerOptions
- context7
- update.md
- Logo Design Reference
- Token Architecture
- design-tokens-starter.json
- TestDomainDetection
- TestSearchDomains
- compilerOptions
- BuildX Design System — Lean, Premium, Monochrome
- extract-colors.cjs
- validate-asset.cjs
- Primitive Tokens
- card
- Core Visual Elements
- CIP Design Style Guide
- registry.ts
- Brand
- Slide Strategies
- Component Tokens
- embed-tokens.cjs
- validate-tokens.cjs
- blue
- button
- duration
- Slide Strategies
- src/git.test.ts
- ops.ts
- Storage
- agent.test.ts
- inject-brand-context.cjs
- BM25
- BM25
- createStorage
- terminal-client.ts
- sync-brand-to-tokens.cjs
- generate-tokens.cjs
- input
- box-sandbox.test.ts
- devDependencies
- Slides Reference
- HTML Slide Template
- HTML Slide Template
- panel-tabs.ts
- scripts
- Slides
- kv-cache.ts
- Brand Guidelines Template
- $type
- $type
- radius
- lg
- sm
- TestBm25CoreBehavior
- dependencies
- 800
- padding-y
- xl
- agent/tsconfig.json
- db/tsconfig.json
- sandbox/tsconfig.json
- shared/tsconfig.json
- devDependencies
- storage/tsconfig.json
- .opencode/opencode.json
- destructive
- destructive-foreground
- muted
- primary-foreground
- ring
- secondary-foreground
- postcss.config.mjs
- slides-create.md
- create.md
- { signIn, signUp, signOut, useSession }

## God Nodes (most connected - your core abstractions)
1. `Button()` - 79 edges
2. `getCurrentUser()` - 72 edges
3. `react` - 68 edges
4. `unauthorized()` - 67 edges
5. `getDb()` - 65 edges
6. `TailwindConfigGenerator` - 58 edges
7. `WorkspaceGit` - 45 edges
8. `lucide-react` - 44 edges
9. `BoxSandbox` - 44 edges
10. `Sandbox` - 42 edges

## Surprising Connections (you probably didn't know these)
- `Interaction (App)` --references--> `Button()`  [INFERRED]
  .opencode/skills/ui-ux-pro-max/SKILL.md → apps/web/components/ui/button.tsx
- `Running the dashboard` --references--> `WorkspaceSource`  [INFERRED]
  AGENTS.md → apps/web/lib/workspace-source.ts
- `Phase 8 — Lazy sandbox + web wiring` --references--> `Sandbox`  [INFERRED]
  phase.md → packages/sandbox/src/index.ts
- `4. Tech Stack` --references--> `Sandbox`  [INFERRED]
  plan.md → packages/sandbox/src/index.ts
- `Phase 5 — Lazy sandbox + web wiring (week 5–6)` --references--> `Sandbox`  [INFERRED]
  plan.md → packages/sandbox/src/index.ts

## Import Cycles
- 2-file cycle: `packages/sandbox/src/index.ts -> packages/sandbox/src/lazy-box.ts -> packages/sandbox/src/index.ts`

## Communities (213 total, 26 thin omitted)

### Community 0 - "Button"
Cohesion: 0.06
Nodes (72): McpSettingsPage(), metadata, CatalogConnectDialog(), CatalogConnectFields(), buildHeaders(), connect(), runTest(), authLabel() (+64 more)

### Community 1 - "validate_data.py"
Cohesion: 0.06
Nodes (44): read_rows(), TestAccessibilityGuidance, TestChartsTypographyAndIcons, TestCurrentReactGuidance, TestSemanticColors, TestGeneratedCatalogContract, _catalog_date(), _check_app_interface_contract() (+36 more)

### Community 2 - "design_system.py"
Cohesion: 0.04
Nodes (24): ansi_ljust(), _detect_page_type(), format_ascii_box(), format_markdown(), format_master_md(), format_page_override_md(), generate_design_system(), _generate_intelligent_overrides() (+16 more)

### Community 3 - "github/github.test.ts"
Cohesion: 0.07
Nodes (54): dynamic, GET(), redirectBack(), runtime, dynamic, GET(), runtime, dynamic (+46 more)

### Community 4 - "ShadcnInstaller"
Cohesion: 0.05
Nodes (3): main(), ShadcnInstaller, TestShadcnInstaller

### Community 5 - "json"
Cohesion: 0.05
Nodes (19): test_sync_parses_bundled_starter_template(), build_cip_prompt(), check_logo_required(), generate_cip_set(), generate_with_nano_banana(), load_env(), load_logo_image(), main() (+11 more)

### Community 6 - "scripts/core.py"
Cohesion: 0.06
Nodes (31): BM25, _contains_phrase(), detect_domain(), _domain_keywords(), _exact_match_diagnostic(), _exact_row_identity(), _exact_stack_identifier(), _file_signature() (+23 more)

### Community 7 - "servers/[id]/route.ts"
Cohesion: 0.09
Nodes (51): DELETE(), dynamic, GET(), Params, PATCH(), runtime, dynamic, Params (+43 more)

### Community 8 - "agent/src/skills.ts"
Cohesion: 0.08
Nodes (59): archiveCandidates(), assertPublicHost(), assertResolvedPublic(), assertSafeSkillUrl(), assertTextFile(), basename(), buildPackage(), candidateFromMarkdown() (+51 more)

### Community 9 - "shared/src/index.ts"
Cohesion: 0.05
Nodes (54): GET(), dynamic, fetchOpenRouterCatalog(), GET(), ModelOption, OPENROUTER_FALLBACK_MODELS, prettifyId(), RemoteModel (+46 more)

### Community 10 - "tool-row.tsx"
Cohesion: 0.10
Nodes (49): pretty(), StreamItem, toStreamItems(), AnsiOutput(), bashOutput(), BashTarget(), BashTool(), ContextCompactionRow() (+41 more)

### Community 11 - "schema.ts"
Cohesion: 0.05
Nodes (48): Repo status, buildDb(), DbClientOptions, globalForDb, resolveDriver(), withAdvisoryLock(), canStartRun(), closeUsageSession() (+40 more)

### Community 12 - "[id]/page.tsx"
Cohesion: 0.08
Nodes (40): GitHubRepository, GitHubState, NewChatPage(), send(), isQueuedTurn(), lastAssistantText(), OptimisticMessage, QueuedTurn (+32 more)

### Community 13 - "shell-context.tsx"
Cohesion: 0.10
Nodes (42): ShellLayout(), PLANS, PricingPage(), Section(), SettingsPage(), subscribe(), useMounted(), AppShell() (+34 more)

### Community 14 - "job-worker.ts"
Cohesion: 0.09
Nodes (40): instrumentation, startWorker(), acquireSession(), configOf(), DEFAULT_CONFIG, defaultDeps(), finalizeEarly(), log() (+32 more)

### Community 15 - "getCurrentUser"
Cohesion: 0.08
Nodes (39): dynamic, GET(), dynamic, GET(), POST(), dynamic, POST(), runtime (+31 more)

### Community 16 - "terminal.ts"
Cohesion: 0.08
Nodes (42): dynamic, isAbortError(), jsonError(), message(), POST(), runtime, acquireTerminalSlot(), canAccessWorkspace() (+34 more)

### Community 17 - "test_design_system_mode.py"
Cohesion: 0.07
Nodes (14): _contrast_ratio(), _derive_dark_palette(), _filter_anti_patterns_for_mode(), _palette_is_dark(), _query_wants_dark(), _relative_luminance(), _resolve_color_mode(), _select_palette_for_mode() (+6 more)

### Community 18 - "skills/store.ts"
Cohesion: 0.08
Nodes (45): dynamic, GET(), installSchema, isMissingTableError(), isStorageUnavailableError(), POST(), runtime, ArtifactEnvelope (+37 more)

### Community 19 - "thinking-trace.tsx"
Cohesion: 0.07
Nodes (40): ChatEmptyState(), prettifyModel(), STARTERS, ActivityState, BARS, baseName(), commandKind(), formatElapsed() (+32 more)

### Community 20 - "lib/store.ts"
Cohesion: 0.11
Nodes (38): makeRun(), closeRun(), guardSandbox(), startRun(), cancelRemoteBoxExecution(), appendEvent(), appendTails, bindClaim() (+30 more)

### Community 21 - "shell/sidebar.tsx"
Cohesion: 0.10
Nodes (23): ChatComposer(), handleSubmit(), onKeyDown(), toggleSkill(), ModelPicker(), renderItem(), StatusDot(), CodeComparisonProps (+15 more)

### Community 22 - "Sandbox"
Cohesion: 0.05
Nodes (32): Commands (run these to verify), graphify, Quirks (learned the hard way), Running the dashboard, When implementing, StartTerminalSessionOptions, 10. Harness Alternatives (benchmark later), 1. System Overview (+24 more)

### Community 23 - "react"
Cohesion: 0.09
Nodes (28): GitHubConnection(), load(), GitHubStatus, LoadState, statusNotice(), AccountHeader(), DesktopMenu(), MobileMenu() (+20 more)

### Community 24 - "icon/generate.py"
Cohesion: 0.07
Nodes (17): generate_html(), get_deliverable_info(), get_image_base64(), main(), apply_color(), apply_viewbox_size(), extract_svgs(), generate_batch() (+9 more)

### Community 25 - "oauth.ts"
Cohesion: 0.08
Nodes (37): catalogAuthHeaders(), getCatalogEntry(), MCP_CATALOG, popularCatalog(), ENTRY, OAUTH, buildAuthorizationUrl(), codeChallenge() (+29 more)

### Community 26 - "slide_search_core.py"
Cohesion: 0.08
Nodes (17): format_context(), format_result(), main(), BM25, calculate_pattern_break(), detect_domain(), get_background_config(), get_color_for_emotion() (+9 more)

### Community 27 - "Tailwind CSS Utility Reference"
Cohesion: 0.05
Nodes (43): Arbitrary Values, Aspect Ratio, Background Colors, Border Color, Border Radius, Border Style, Border Width, Borders (+35 more)

### Community 28 - "DesignSystemGenerator"
Cohesion: 0.09
Nodes (5): DesignSystemGenerator, TestReasoningMatch, read_rows(), TestLandingAndStackContract, TestReasoningContract

### Community 29 - "TestSandbox"
Cohesion: 0.07
Nodes (8): abortError(), TestSandbox, LocalSandbox, RecordingSandbox, spawnShell(), CheckpointId, ProcId, ReadRange

### Community 30 - "WorkspaceGit"
Cohesion: 0.18
Nodes (9): credentialEnv(), describe(), GitError, pullRequestDraftPath(), safeRepoName(), validateBranchName(), validateRemoteName(), validateRepoPath() (+1 more)

### Community 31 - "ui/sidebar.tsx"
Cohesion: 0.07
Nodes (20): Progress(), ProgressIndicator(), ProgressTrack(), Separator(), SidebarContext, SidebarContextProps, SidebarInput(), SidebarMenuButton() (+12 more)

### Community 33 - "db/package.json"
Cohesion: 0.05
Nodes (36): nextConfig, rootDir, dependencies, @buildx/shared, drizzle-orm, @neondatabase/serverless, pg, devDependencies (+28 more)

### Community 34 - "lib/quota.ts"
Cohesion: 0.09
Nodes (26): dynamic, GET(), createQuotaService(), read(), reserve(), transition(), DAILY_MODEL_REQUEST_LIMIT, getQuotaService() (+18 more)

### Community 35 - "git/route.ts"
Cohesion: 0.10
Nodes (34): dynamic, GET(), invalid(), Params, PUT(), querySchema, runtime, updateSchema (+26 more)

### Community 36 - "workspace-panel.tsx"
Cohesion: 0.09
Nodes (36): CollapseButton, defaultTreeComparator(), Direction, File, Folder, FolderProps, getTreeComparator(), isFolderElement() (+28 more)

### Community 37 - "dependencies"
Cohesion: 0.05
Nodes (39): dependencies, ai, @ai-sdk/openai, anser, @base-ui/react, better-auth, @better-auth/drizzle-adapter, @buildx/agent (+31 more)

### Community 38 - "agent/package.json"
Cohesion: 0.05
Nodes (38): dependencies, ai, @ai-sdk/openai, @buildx/sandbox, @buildx/shared, @langchain/core, @langchain/langgraph, @langchain/langgraph-checkpoint-postgres (+30 more)

### Community 39 - "tools.ts"
Cohesion: 0.11
Nodes (35): abortError(), AgentTools, boundBashOutput(), buildTools(), chunkFile(), cleanBashStream(), escapeRegExp(), execCapture() (+27 more)

### Community 40 - "csv"
Cohesion: 0.07
Nodes (11): generate_css_for_background(), get_background_image(), get_curated_images(), get_overlay_css(), get_pexels_search_url(), load_backgrounds_config(), load_brand_colors(), main() (+3 more)

### Community 41 - "sandbox/src/index.ts"
Cohesion: 0.11
Nodes (34): GitListResponse, FileEntry, FilesResponseItem, buildCommand(), buildDescription(), capOutput(), CommandResult, GitBranches (+26 more)

### Community 42 - "BoxSandbox"
Cohesion: 0.10
Nodes (7): BoxWorkspaceSource, walk(), apiKey, loadEnv(), main(), BoxSandbox, isNotFound()

### Community 43 - "Brand Guidelines v1.0"
Cohesion: 0.05
Nodes (37): 1. Color Palette, 2. Typography, 3. Logo Usage, 4. Voice & Tone, 5. Imagery Guidelines, 6. Design Components, Accessibility, AI Image Generation (+29 more)

### Community 44 - "run-creation.ts"
Cohesion: 0.09
Nodes (33): dynamic, ShellMeta, TestDeps, QuotaSnapshot, createRunForUser(), CreateRunInput, CreateRunResult, ensureConversation() (+25 more)

### Community 45 - "ref_node_assert"
Cohesion: 0.10
Nodes (13): secret, createdUsers, listMcpServers(), createdUsers, createdUsers, inputFor(), quotaAt(), user (+5 more)

### Community 46 - "Design"
Cohesion: 0.06
Nodes (35): Banner Design (Built-in), Banner: Design Rules, Banner: Quick Size Reference, Banner: Top Art Styles, Banner: Workflow, CIP Design (Built-in), CIP: Generate Brief, CIP: Generate Mockups (+27 more)

### Community 47 - "Canvas Design System"
Cohesion: 0.06
Nodes (35): 1. Visual Communication First, 2. Minimal Text Integration, 3. Expert Craftsmanship, 4. Systematic Patterns, Analog Meditation, Approach, Canvas Boundaries, Canvas Design System (+27 more)

### Community 48 - "Prerequisites"
Cohesion: 0.06
Nodes (34): Accessibility, Available Domains, Available Stacks, Common Rules for Professional UI, Common Sticking Points, Example Workflow, How to Use This Skill, Icons & Visual Elements (+26 more)

### Community 49 - "agent/src/index.ts"
Cohesion: 0.10
Nodes (29): ContextBudgetOptions, GitHubToolsOptions, buildLangGraph(), buildToolSet(), createAgent(), CreateAgentOptions, describeProviderError(), runTask() (+21 more)

### Community 50 - "spacing"
Cohesion: 0.06
Nodes (34): $type, $value, $type, $value, $type, $value, $type, $value (+26 more)

### Community 51 - "scripts"
Cohesion: 0.06
Nodes (31): devDependencies, eslint, @eslint/js, eslint-plugin-react-hooks, tsx, @types/node, typescript, typescript-eslint (+23 more)

### Community 52 - "Form & Input Components"
Cohesion: 0.06
Nodes (32): Accordion, Alert, Alert Dialog, Avatar, Badge, Button, Card, Checkbox (+24 more)

### Community 53 - "Tailwind CSS Responsive Design"
Cohesion: 0.06
Nodes (32): 1. Mobile-First Design, 2. Consistent Breakpoint Usage, 3. Test at Breakpoint Boundaries, 4. Use Container for Content Width, 5. Progressive Enhancement, 6. Avoid Too Many Breakpoints, Best Practices, Breakpoint System (+24 more)

### Community 54 - "unittest"
Cohesion: 0.07
Nodes (6): TestFixtureValidation, TestMetricMath, TestThresholdGate, read_rows(), TestTextLayoutDataContracts, TestTextLayoutRetrieval

### Community 55 - "workspace-source.ts"
Cohesion: 0.09
Nodes (18): dynamic, GET(), message(), TimeoutError, withTimeout(), compileRule(), createIgnoreMatcher(), globToRegex() (+10 more)

### Community 56 - "right-panel.tsx"
Cohesion: 0.15
Nodes (25): PanelSplit(), EmptyWorkspace(), PanelBody(), PanelHeader(), RightPanel(), RightPanelDrawer(), detailError(), formatBytes() (+17 more)

### Community 57 - "web/package.json"
Cohesion: 0.07
Nodes (30): CodeComparison(), highlightCode(), ai, @ai-sdk/openai, @buildx/db, @buildx/sandbox, @buildx/shared, @buildx/storage (+22 more)

### Community 58 - "Typography Specifications"
Cohesion: 0.06
Nodes (30): Accessibility, Base System, Best Practices, Clean & Modern, Common Font Pairings, Contrast Requirements, CSS Implementation, Editorial (+22 more)

### Community 59 - "findOwnedRun"
Cohesion: 0.15
Nodes (23): dynamic, pendingOptions(), POST(), dynamic, GET(), dynamic, POST(), dynamic (+15 more)

### Community 60 - "workspace-git.tsx"
Cohesion: 0.15
Nodes (23): Alert(), AlertDescription(), alertVariants, Textarea(), ApiFailure, BranchOptions(), Failure(), GitHubRepositoriesResponse (+15 more)

### Community 61 - "SessionHandle"
Cohesion: 0.09
Nodes (9): TerminalSessionEntry, TerminalSessionRun, FakeSandbox, FakeSession, sink(), SessionRecordingSandbox, SessionHandle, SessionOptions (+1 more)

### Community 62 - "Logo Usage Rules"
Cohesion: 0.07
Nodes (28): Absolute Don'ts, Approved Backgrounds, Before Using Logo, Clear Space, Co-branding, Color Rules, Color Usage, Color Variants (+20 more)

### Community 63 - "Component Specifications"
Cohesion: 0.07
Nodes (28): Alert, Anatomy, Anatomy, Anatomy, Anatomy, Anatomy, Badge, Button (+20 more)

### Community 64 - "html-token-validator.py"
Cohesion: 0.13
Nodes (12): get_context(), is_allowed_exception(), is_allowed_rgba(), is_inside_block(), load_css_variables(), main(), print_result(), print_summary() (+4 more)

### Community 65 - "shadcn/ui Accessibility Patterns"
Cohesion: 0.07
Nodes (28): Accordion, Alert, ARIA Labels, Checkbox and Radio, Color Contrast, Command Palette Navigation, Component-Specific Patterns, Dialog/Modal Navigation (+20 more)

### Community 66 - "sandbox/package.json"
Cohesion: 0.07
Nodes (27): dependencies, @buildx/db, @buildx/shared, @buildx/storage, @upstash/box, zod, devDependencies, tsx (+19 more)

### Community 67 - "sign-in/page.tsx"
Cohesion: 0.14
Nodes (17): GET, POST, dynamic, SignInPage(), dynamic, SignUpPage(), SignInForm(), SignUpForm() (+9 more)

### Community 68 - "cip/core.py"
Cohesion: 0.10
Nodes (11): detect_domain(), get_cip_brief(), _load_csv(), search(), search_all(), _search_csv(), detect_domain(), _load_csv() (+3 more)

### Community 69 - "diff-view.tsx"
Cohesion: 0.12
Nodes (22): WorkspaceDiff, DiffFileCard(), DiffHunkView(), DiffView(), HunkHeader(), HunkLine(), STATUS_LABEL, STATUS_TONE (+14 more)

### Community 70 - "Asset Approval Checklist"
Cohesion: 0.08
Nodes (25): Accessibility, Archival, Asset Approval Checklist, Automation Support, Color Compliance, Common Issues & Fixes, Content Accessibility, Content Quality (+17 more)

### Community 71 - "Logo AI Prompt Engineering"
Cohesion: 0.08
Nodes (25): Common Pitfalls, Core Prompt Structure, Detailed Brief, Eco/Sustainable, Effective Keywords by Style, Fashion Brand, Healthcare, Industry-Specific Prompts (+17 more)

### Community 72 - "skills-page.tsx"
Cohesion: 0.15
Nodes (22): metadata, SkillsSettingsPage(), InstallSkillDialog(), PreviewDetail, SkillDetailSheet(), messageFor(), SkillsPage(), handleDelete() (+14 more)

### Community 73 - "Color Palette Management"
Cohesion: 0.08
Nodes (24): Accessibility Requirements, Brand Compliance Validation, Checking Contrast, Color Documentation Format, Color Extraction, Color Palette Examples, Color Palette Management, Color System Structure (+16 more)

### Community 74 - "CIP Deliverable Guide"
Cohesion: 0.08
Nodes (24): Apparel, Business Card, Car/Sedan, CIP Deliverable Guide, Core Identity, Digital Assets, Email Signature, Envelope (+16 more)

### Community 75 - "States and Variants"
Cohesion: 0.08
Nodes (24): Accessibility, Accessibility Requirements, ARIA States, Color Contrast, Color Variants, Disabled States, Error Messages, Error States (+16 more)

### Community 76 - "UI Styling Skill"
Cohesion: 0.08
Nodes (24): Accessibility Patterns, Alternative: Tailwind-Only Setup, Best Practices, Common Patterns, Component Layer: shadcn/ui, Component Library Guide, Component + Styling Setup, Core Stack (+16 more)

### Community 77 - "Workflow"
Cohesion: 0.08
Nodes (23): Art Direction Styles (Reuse from Banner), Color & Contrast, Design Best Practices, HTML Design Rules, HTML Template Structure, Option A: Chrome Headless CLI (Recommended — zero dependencies), Option B: chrome-devtools skill, Option C: Playwright script (+15 more)

### Community 78 - "code-viewer.tsx"
Cohesion: 0.18
Nodes (17): ChatMarkdown(), CodeBlock(), copyText(), HighlightedCode(), CodeViewer(), CopyButton(), copyText(), formatBytes() (+9 more)

### Community 79 - "Design System"
Cohesion: 0.09
Nodes (22): Best Practices, Chart.js Integration, Command, Component Spec Pattern, Contextual Decision Flow, Decision System CSVs, Design System, Integration (+14 more)

### Community 80 - "Tailwind CSS Customization"
Cohesion: 0.09
Nodes (22): @apply Directive, Best Practices, Color Customization, Complete Tailwind Config, Configuration Examples, Content Configuration, Custom Color Palette, Custom Font Sizes (+14 more)

### Community 81 - "mcp.ts"
Cohesion: 0.14
Nodes (18): allowPrivateByDefault(), assertSafeMcpUrl(), BLOCKED_IPV4, buildMcpTools(), connectMcpServer(), createSafeFetch(), DEFAULT_MCP_TIMEOUT_MS, inCidr() (+10 more)

### Community 82 - "box-sandbox.ts"
Cohesion: 0.17
Nodes (13): pendingStarts, shellQuoteSingle(), abortError(), BUFFER_CAP_BYTES, ChunkBuffer, exitMarker(), ExecChunk, ExecOptions (+5 more)

### Community 83 - "components.json"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 84 - "shared/package.json"
Cohesion: 0.09
Nodes (21): dependencies, zod, devDependencies, tsx, @types/node, typescript, exports, ./node (+13 more)

### Community 85 - "generate-slide.py"
Cohesion: 0.13
Nodes (10): _e(), generate_chart_slide(), generate_cta_slide(), generate_deck(), generate_metrics_slide(), generate_problem_slide(), generate_solution_slide(), generate_testimonial_slide() (+2 more)

### Community 86 - "buildGitHubTools"
Cohesion: 0.18
Nodes (12): branchSlug(), buildGitHubTools(), GitHubPublishClient, GitHubPublishError, GitHubPullRequest, GitHubRepository, GitHubToolAuth, isSshRemote() (+4 more)

### Community 87 - "context.ts"
Cohesion: 0.10
Nodes (6): download(), CloudflareEnv, KVBinding, QueueBinding, R2Binding, R2ObjectBody

### Community 88 - "Routing by Task Type"
Cohesion: 0.10
Nodes (19): Banner Design Tasks, Brand Identity Tasks, Component Creation, Corporate Identity Program Tasks, Design Routing Guide, Design System Migration, Icon Design Tasks, Implementation Tasks (+11 more)

### Community 89 - "shadcn/ui Theming & Customization"
Cohesion: 0.10
Nodes (19): Base Color Presets, Best Practices, Color Customization, Color Format, Component Customization, CSS Variable System, Customize Styles, Customize Variants (+11 more)

### Community 90 - "conversation-sync.ts"
Cohesion: 0.20
Nodes (16): clearPendingConversationQueue(), EMPTY_QUEUE, enqueueConversationEvent(), flushConversationSync(), nextSeq(), PENDING_QUEUE_KEY, PendingConversationEvent, PersistedQueue (+8 more)

### Community 91 - "Asset Organization Guide"
Cohesion: 0.11
Nodes (18): Asset Entry (manifest.json), Asset Organization Guide, By Campaign, By Status, By Type, Cleanup Workflow, Components, Directory Structure (+10 more)

### Community 92 - "Primary Color Meanings"
Cohesion: 0.11
Nodes (18): Accessibility Considerations, Analogous, Black, Blue, Color Combinations by Industry, Color Harmony Types, Complementary, Green (+10 more)

### Community 93 - "Core Logo Types"
Cohesion: 0.11
Nodes (18): 1. Wordmark (Logotype), 2. Lettermark (Monogram), 3. Pictorial Mark (Brand Mark), 4. Abstract Mark, 5. Mascot, 6. Emblem, 7. Combination Mark, Aesthetic Styles (+10 more)

### Community 94 - "gray"
Cohesion: 0.11
Nodes (19): $type, $value, $type, $value, $type, $value, $type, $value (+11 more)

### Community 95 - "color"
Cohesion: 0.11
Nodes (19): $type, $value, background, foreground, muted-foreground, primary, primary-hover, secondary (+11 more)

### Community 96 - "agent/src/skills.test.ts"
Cohesion: 0.16
Nodes (9): buildSelectedSkillsSection(), clipChars(), createSkillRuntime(), createSkillTools(), safeSkillPath(), SkillRuntime, skillRuntimeFromPackages(), skillSourceFromPackage() (+1 more)

### Community 97 - "Brand Consistency Checklist"
Cohesion: 0.11
Nodes (17): Audit Frequency, Brand Consistency Checklist, Channel Audit, Collateral, Colors, Common Issues, Email, Imagery (+9 more)

### Community 98 - "CIP Mockup Prompt Engineering"
Cohesion: 0.11
Nodes (17): Apparel (Polo/T-Shirt), Base Prompt Structure, Business Card, CIP Mockup Prompt Engineering, Context Modifiers, Corporate Minimal, Deliverable-Specific Modifiers, Letterhead (+9 more)

### Community 99 - "Color Semantics"
Cohesion: 0.11
Nodes (17): Accent, Applying Semantic Tokens, Background & Foreground, Border & Ring, Color Semantics, Dark Mode Overrides, Destructive, Interactive States (+9 more)

### Community 100 - "radius"
Cohesion: 0.15
Nodes (18): $type, $value, $type, $value, $type, $value, $type, $value (+10 more)

### Community 101 - "context-budget.ts"
Cohesion: 0.21
Nodes (15): AnyRecord, clip(), contentToText(), ContextBudget, createContextBudget(), DEFAULT_CONTEXT_BUDGET_TOKENS, digestMessages(), estimateMessageTokens() (+7 more)

### Community 102 - "BuildX"
Cohesion: 0.11
Nodes (17): claimRunById(), API reference, Architecture, BuildX, Contributing, Correctness safeguards, Deploying to Cloudflare Workers, Key environment variables (+9 more)

### Community 103 - "6. Phases"
Cohesion: 0.11
Nodes (17): 1. Vision, 2. Goals, 3. Non-Goals (v1), 4. Tech Stack, 5. Core Concepts, 6. Phases, 7. Acceptance checklist (final), 8. Open questions / risks (+9 more)

### Community 104 - "chat-message.tsx"
Cohesion: 0.21
Nodes (15): AssistantBlocks(), ChatMessageView(), copyText(), ErrorBlock(), MessageActions(), TextBlock(), TodoPlanBlock(), UsageFooter() (+7 more)

### Community 105 - "storage/package.json"
Cohesion: 0.12
Nodes (16): exports, @buildx/shared, tsx, @types/node, typescript, zod, main, name (+8 more)

### Community 106 - "ops.test.ts"
Cohesion: 0.26
Nodes (9): createS3Client(), loadStorageEnv(), StorageEnv, storageEnvSchema, assertBucketReachable(), ensureBuckets(), REQUIRED_BUCKETS, @aws-sdk/client-s3 (+1 more)

### Community 107 - "query-provider.tsx"
Cohesion: 0.23
Nodes (13): SessionCacheGuard(), clearQueryCache(), createClient(), defaultOptions, getQueryClient(), QUERY_CACHE_KEY, QUERY_CACHE_MAX_AGE_MS, QUERY_CACHE_OWNER_KEY (+5 more)

### Community 108 - "workspace-terminal.tsx"
Cohesion: 0.18
Nodes (14): errorFromResponse(), message(), newTabId(), PaneStatus, Phase, readTerminalTheme(), TerminalPane(), WorkspaceTerminal() (+6 more)

### Community 109 - "Design Principles"
Cohesion: 0.12
Nodes (15): 22 Art Direction Styles, Banner Sizes & Art Direction Styles Reference, Complete Banner Sizes, CTA Rules, Design Principles, Pinterest Research Queries, Print, Print Specs (+7 more)

### Community 110 - "Design Principles"
Cohesion: 0.12
Nodes (15): 22 Art Direction Styles, Banner Sizes & Art Direction Styles Reference, Complete Banner Sizes, CTA Rules, Design Principles, Pinterest Research Queries, Print, Print Specs (+7 more)

### Community 111 - "fontSize"
Cohesion: 0.12
Nodes (16): $type, $value, $type, $value, $type, $value, $type, $value (+8 more)

### Community 115 - "Phase Plan — Auth + Local Postgres + Local MinIO + Fly.io Free-Tier Sandbox Lifecycle"
Cohesion: 0.12
Nodes (15): Acceptance checklist (final), Items to verify that are NOT confirmed (track all of these), Open questions / risks, Phase 10 — UI + events (`apps/web`), Phase 11 — Docs updates, Phase 1 — docker-compose (Postgres + MinIO) + Drizzle + migrations + storage:init, Phase 2 — Storage module + tests, Phase 4 — Core BuildX schema, transitions + quota functions (+7 more)

### Community 116 - "group-runs.ts"
Cohesion: 0.27
Nodes (12): useConversationPrefs(), ConversationPref, ConversationPrefs, displayTitle(), loadConversationPrefs(), saveConversationPrefs(), upsertConversationPref(), groupLabel() (+4 more)

### Community 117 - "CIP Design Reference"
Cohesion: 0.13
Nodes (14): CIP Brief (Start Here), CIP Design Reference, Commands, Deliverable Categories, Design Styles, Detailed References, Generate Mockups, HTML Presentation Features (+6 more)

### Community 118 - "Icon Design Reference"
Cohesion: 0.13
Nodes (14): Available Styles, CLI Options, Commands, Generate Batch Variations, Generate Multiple Sizes, Generate Single Icon, Icon Categories, Icon Design Reference (+6 more)

### Community 119 - "Copywriting Formulas"
Cohesion: 0.13
Nodes (14): AIDA (Attention-Interest-Desire-Action), Before-After-Bridge, Contrast Patterns, Copywriting Formulas, Core Formulas, Cost of Inaction, FAB (Features-Advantages-Benefits), Formula-to-Slide Mapping (+6 more)

### Community 120 - "color"
Cohesion: 0.19
Nodes (15): $type, $value, 500, green, red, white, yellow, 500 (+7 more)

### Community 121 - "Copywriting Formulas"
Cohesion: 0.13
Nodes (14): AIDA (Attention-Interest-Desire-Action), Before-After-Bridge, Contrast Patterns, Copywriting Formulas, Core Formulas, Cost of Inaction, FAB (Features-Advantages-Benefits), Formula-to-Slide Mapping (+6 more)

### Community 123 - "Banner Design - Multi-Format Creative Banner System"
Cohesion: 0.14
Nodes (13): Art Direction Styles (Top 10), Banner Design - Multi-Format Creative Banner System, Banner Size Quick Reference, Design Rules, Prerequisites, Security, Step 1: Gather Requirements (AskUserQuestion), Step 2: Research & Art Direction (+5 more)

### Community 124 - "Messaging Framework"
Cohesion: 0.14
Nodes (13): Core Statements, Elevator Pitches, Framework Structure, Message Architecture, Message by Audience, Message Testing, Messaging Framework, Mission Statement (+5 more)

### Community 125 - "Brand Voice Framework"
Cohesion: 0.14
Nodes (13): Brand Voice Framework, Character Spectrum, Emotion Spectrum, Language Spectrum, Step 1: Define Personality Traits, Step 2: Create Voice Chart, Step 3: Context Adaptation, Tone Spectrum (+5 more)

### Community 126 - "Layout Patterns"
Cohesion: 0.14
Nodes (13): Card Styles, Component Variants, CSS Structures, Feature Grid (3 columns), Layout Decision Flow, Layout Patterns, Layout Selection by Use Case, Metric Styles (+5 more)

### Community 127 - "Tailwind Integration"
Cohesion: 0.14
Nodes (13): Animation Tokens, Base Layer, Button Example, Component Classes, CSS Variables Setup, Dark Mode Toggle, HSL Format Benefits, shadcn/ui Alignment (+5 more)

### Community 128 - "Layout Patterns"
Cohesion: 0.14
Nodes (13): Card Styles, Component Variants, CSS Structures, Feature Grid (3 columns), Layout Decision Flow, Layout Patterns, Layout Selection by Use Case, Metric Styles (+5 more)

### Community 132 - "app/layout.tsx"
Cohesion: 0.23
Nodes (10): geist, geistMono, metadata, RootLayout(), viewport, ConversationSyncLoop(), Providers(), QueryProvider() (+2 more)

### Community 133 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, allowJs, incremental, isolatedModules, jsx, lib, noEmit, paths (+4 more)

### Community 134 - "context7"
Cohesion: 0.15
Nodes (12): enabled, headers, type, url, mcp, context7, @preset/cheap-coding, models (+4 more)

### Community 135 - "update.md"
Cohesion: 0.15
Nodes (12): Color Presets, Examples, Files Modified, Important, Overview, Skills Used, Step 1: Gather Brand Input, Step 2: Update Brand Guidelines (+4 more)

### Community 136 - "Logo Design Reference"
Cohesion: 0.15
Nodes (12): Available Styles, Color Psychology, Commands, Design Brief (Start Here), Detailed References, Generate Logo, Industry Defaults, Logo Design Reference (+4 more)

### Community 137 - "Token Architecture"
Cohesion: 0.15
Nodes (12): Categories, Dark Mode, File Organization, Layer 1: Primitive Tokens, Layer 2: Semantic Tokens, Layer 3: Component Tokens, Layer Overview, Migration from Flat Tokens (+4 more)

### Community 138 - "design-tokens-starter.json"
Cohesion: 0.15
Nodes (12): component, $type, $value, dark, semantic, $schema, $type, $value (+4 more)

### Community 141 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, lib, module, moduleResolution, noEmit (+4 more)

### Community 142 - "BuildX Design System — Lean, Premium, Monochrome"
Cohesion: 0.17
Nodes (11): BuildX Design System — Lean, Premium, Monochrome, Colors (Dark Theme), Design Tokens (Single Source of Truth), DO, Do / Don't Guidelines, DON'T, Layout, Overview (+3 more)

### Community 143 - "extract-colors.cjs"
Cohesion: 0.27
Nodes (9): calculateCompliance(), colorDistance(), displayPalette(), extractHexColors(), findNearestBrandColor(), generateImageMagickCommand(), hexToRgb(), main() (+1 more)

### Community 144 - "validate-asset.cjs"
Cohesion: 0.32
Nodes (11): checkManifest(), formatBytes(), formatOutput(), main(), parseFilename(), RULES, suggestFilename(), validateAsset() (+3 more)

### Community 145 - "Primitive Tokens"
Cohesion: 0.17
Nodes (11): Border Radius, Color Scales, Gray Scale, Motion / Duration, Primary Colors (Blue), Primitive Tokens, Shadows, Spacing Scale (+3 more)

### Community 146 - "card"
Cohesion: 0.20
Nodes (12): $type, $value, bg, bg, padding, shadow, card, bg (+4 more)

### Community 147 - "Core Visual Elements"
Cohesion: 0.18
Nodes (10): Color Palette, Colors, Core Visual Elements, Logo, Logo, Quick Checks, Typography, Typography (+2 more)

### Community 148 - "CIP Design Style Guide"
Cohesion: 0.18
Nodes (10): Bold Dynamic, CIP Design Style Guide, Classic Traditional, Color Psychology, Corporate Minimal, Fresh Modern, Luxury Premium, Modern Tech (+2 more)

### Community 150 - "registry.ts"
Cohesion: 0.24
Nodes (9): CacheEntry, FetchRegistryOptions, fetchRegistryServers(), globalForRegistry, MCP_REGISTRY_BASE_URL, parseServers(), RegistryListResponse, RegistryServer (+1 more)

### Community 151 - "Brand"
Cohesion: 0.20
Nodes (9): Brand, Brand Sync Workflow, Quick Start, References, Routing, Scripts, Subcommands, Templates (+1 more)

### Community 152 - "Slide Strategies"
Cohesion: 0.20
Nodes (9): Common Structures, Duarte Sparkline Pattern, Matching Strategy to Context, Product Demo (6 slides), Sales Pitch (9 slides), Search Commands, Slide Strategies, Strategy Selection (+1 more)

### Community 153 - "Component Tokens"
Cohesion: 0.20
Nodes (9): Alert Tokens, Badge Tokens, Button Tokens, Card Tokens, Component Tokens, Dialog/Modal Tokens, Input Tokens, Table Tokens (+1 more)

### Community 154 - "embed-tokens.cjs"
Cohesion: 0.20
Nodes (6): args, minimal, MINIMAL_TOKENS, projectRoot, tokensPath, wrapStyle

### Community 155 - "validate-tokens.cjs"
Cohesion: 0.31
Nodes (9): extensions, formatReport(), getFiles(), main(), parseArgs(), patterns, scanFile(), shouldSkip() (+1 more)

### Community 156 - "blue"
Cohesion: 0.27
Nodes (10): $type, $value, $type, $value, 50, 600, blue, 50 (+2 more)

### Community 157 - "button"
Cohesion: 0.20
Nodes (10): fg, font-size, hover-bg, button, $type, $value, $type, $value (+2 more)

### Community 158 - "duration"
Cohesion: 0.20
Nodes (10): fast, normal, slow, $type, $value, $type, $value, duration (+2 more)

### Community 159 - "Slide Strategies"
Cohesion: 0.20
Nodes (9): Common Structures, Duarte Sparkline Pattern, Matching Strategy to Context, Product Demo (6 slides), Sales Pitch (9 slides), Search Commands, Slide Strategies, Strategy Selection (+1 more)

### Community 160 - "src/git.test.ts"
Cohesion: 0.27
Nodes (8): hasControlCharacters(), taskBranchName(), createRepo(), gitCli(), initialCommit(), write(), validateRepoFile(), validateRepositoryUrl()

### Community 161 - "ops.ts"
Cohesion: 0.20
Nodes (8): DEFAULT_PRESIGN_SECONDS, ListEntry, MAX_BACKUP_BYTES, MAX_OBJECT_BYTES, MAX_PRESIGN_SECONDS, ObjectInfo, PresignOptions, RotateResult

### Community 164 - "inject-brand-context.cjs"
Cohesion: 0.42
Nodes (8): extractColorsFromTable(), extractCoreAttributes(), extractHexColors(), extractImageStyle(), extractTypography(), extractVoice(), generatePromptAddition(), main()

### Community 167 - "createStorage"
Cohesion: 0.29
Nodes (6): dynamic, GET(), createS3SigningClient(), createStorage(), head(), isNotFound()

### Community 168 - "terminal-client.ts"
Cohesion: 0.50
Nodes (6): pushTerminalHistory(), readTerminalHistory(), takeNdjsonRecords(), TERMINAL_HISTORY_LIMIT, terminalCellSize(), terminalHistoryKey()

### Community 169 - "sync-brand-to-tokens.cjs"
Cohesion: 0.39
Nodes (5): adjustBrightness(), extractColorsFromMarkdown(), generateColorScale(), main(), updateDesignTokens()

### Community 170 - "generate-tokens.cjs"
Cohesion: 0.50
Nodes (7): flattenTokens(), generateCSS(), generateTailwind(), main(), parseArgs(), resolveReference(), toCssVarName()

### Community 171 - "input"
Cohesion: 0.29
Nodes (8): padding-x, input, $type, $value, focus-ring, padding-x, $type, $value

### Community 174 - "box-sandbox.test.ts"
Cohesion: 0.29
Nodes (7): BoxMockOptions, DEFAULT_STDERR, DEFAULT_STDOUT, ExecChunk, makeMockBox(), makeStreamRun(), makeSandbox()

### Community 175 - "devDependencies"
Cohesion: 0.29
Nodes (7): devDependencies, tailwindcss, @tailwindcss/postcss, @types/node, @types/react, @types/react-dom, typescript

### Community 176 - "Slides Reference"
Cohesion: 0.29
Nodes (6): Key Features, Knowledge Base, Slides Reference, Usage, When to Use, Workflow

### Community 177 - "HTML Slide Template"
Cohesion: 0.29
Nodes (6): Animation Classes, Background Images, Base Structure, Chart.js Integration, CSS Variables Reference, HTML Slide Template

### Community 178 - "HTML Slide Template"
Cohesion: 0.29
Nodes (6): Animation Classes, Background Images, Base Structure, Chart.js Integration, CSS Variables Reference, HTML Slide Template

### Community 179 - "panel-tabs.ts"
Cohesion: 0.67
Nodes (4): DEFAULT_PANEL_TAB, isPanelTab(), PANEL_TABS, toPanelTab()

### Community 180 - "scripts"
Cohesion: 0.33
Nodes (6): scripts, build, dev, start, test, typecheck

### Community 181 - "Slides"
Cohesion: 0.33
Nodes (5): References (Knowledge Base), Routing, Slides, Subcommands, When to Use

### Community 183 - "Brand Guidelines Template"
Cohesion: 0.40
Nodes (4): Brand Guidelines Template, Document Structure, Extractable Fields, Usage

### Community 184 - "$type"
Cohesion: 0.60
Nodes (5): $type, $value, 700, 700, 700

### Community 185 - "$type"
Cohesion: 0.60
Nodes (5): $type, $value, border, border, border

### Community 186 - "radius"
Cohesion: 0.60
Nodes (5): radius, radius, radius, $type, $value

### Community 187 - "lg"
Cohesion: 0.60
Nodes (5): lg, $type, $value, lg, lg

### Community 188 - "sm"
Cohesion: 0.60
Nodes (5): sm, sm, sm, $type, $value

### Community 190 - "dependencies"
Cohesion: 0.40
Nodes (5): dependencies, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @buildx/shared, zod

### Community 192 - "800"
Cohesion: 0.67
Nodes (4): $type, $value, 800, 800

### Community 193 - "padding-y"
Cohesion: 0.67
Nodes (4): padding-y, padding-y, $type, $value

### Community 194 - "xl"
Cohesion: 0.67
Nodes (4): xl, xl, $type, $value

### Community 196 - "agent/tsconfig.json"
Cohesion: 0.50
Nodes (3): extends, include, ../../tsconfig.base.json

### Community 197 - "db/tsconfig.json"
Cohesion: 0.50
Nodes (3): extends, include, ../../tsconfig.base.json

### Community 198 - "sandbox/tsconfig.json"
Cohesion: 0.50
Nodes (3): extends, include, ../../tsconfig.base.json

### Community 199 - "shared/tsconfig.json"
Cohesion: 0.50
Nodes (3): extends, include, ../../tsconfig.base.json

### Community 200 - "devDependencies"
Cohesion: 0.50
Nodes (4): devDependencies, tsx, @types/node, typescript

### Community 201 - "storage/tsconfig.json"
Cohesion: 0.50
Nodes (3): extends, include, ../../tsconfig.base.json

### Community 203 - "destructive"
Cohesion: 0.67
Nodes (3): destructive, $type, $value

### Community 204 - "destructive-foreground"
Cohesion: 0.67
Nodes (3): destructive-foreground, $type, $value

### Community 205 - "muted"
Cohesion: 0.67
Nodes (3): muted, $type, $value

### Community 206 - "primary-foreground"
Cohesion: 0.67
Nodes (3): primary-foreground, $type, $value

### Community 207 - "ring"
Cohesion: 0.67
Nodes (3): ring, $type, $value

### Community 208 - "secondary-foreground"
Cohesion: 0.67
Nodes (3): secondary-foreground, $type, $value

## Knowledge Gaps
- **63 isolated node(s):** `RFC-7636`, `RFC-7230`, `@ai-sdk/openai`, `@better-auth/drizzle-adapter`, `@buildx/agent` (+58 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 2251 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **26 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `react` to `Button`, `app/layout.tsx`, `shared/src/index.ts`, `tool-row.tsx`, `[id]/page.tsx`, `shell-context.tsx`, `thinking-trace.tsx`, `shell/sidebar.tsx`, `ui/sidebar.tsx`, `workspace-panel.tsx`, `right-panel.tsx`, `web/package.json`, `workspace-git.tsx`, `sign-in/page.tsx`, `diff-view.tsx`, `skills-page.tsx`, `code-viewer.tsx`, `conversation-sync.ts`, `chat-message.tsx`, `query-provider.tsx`, `workspace-terminal.tsx`, `group-runs.ts`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **What connects `RFC-7636`, `RFC-7230`, `@ai-sdk/openai` to the rest of the system?**
  _63 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Button` be split into smaller, more focused modules?**
  _Cohesion score 0.063585291113381 - nodes in this community are weakly interconnected._
- **Why does `Button()` connect `Button` to `sign-in/page.tsx`, `workspace-panel.tsx`, `chat-message.tsx`, `skills-page.tsx`, `[id]/page.tsx`, `shell-context.tsx`, `code-viewer.tsx`, `workspace-terminal.tsx`, `Prerequisites`, `shell/sidebar.tsx`, `react`, `right-panel.tsx`, `workspace-git.tsx`, `ui/sidebar.tsx`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **Should `validate_data.py` be split into smaller, more focused modules?**
  _Cohesion score 0.06202435312024353 - nodes in this community are weakly interconnected._
- **Why does `Sandbox` connect `Sandbox` to `src/git.test.ts`, `LazyBoxSandbox`, `git/route.ts`, `tools.ts`, `6. Phases`, `sandbox/src/index.ts`, `BoxSandbox`, `schema.ts`, `terminal.ts`, `agent/src/index.ts`, `box-sandbox.ts`, `Phase Plan — Auth + Local Postgres + Local MinIO + Fly.io Free-Tier Sandbox Lifecycle`, `lib/store.ts`, `buildGitHubTools`, `TestSandbox`, `WorkspaceGit`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Should `design_system.py` be split into smaller, more focused modules?**
  _Cohesion score 0.03990610328638498 - nodes in this community are weakly interconnected._