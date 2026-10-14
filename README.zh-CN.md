# dsh-mattpocock-skills

把 **[Matt Pocock 的 agent skills](https://github.com/mattpocock/skills)** 镜像进 DeepSeek Harness，
并与上游仓库保持同步的 DSH 插件。

[English](./README.md)

## 功能

- **运行时镜像上游仓库。** 插件从 GitHub 下载 `mattpocock/skills` 的归档到本地缓存，并通过 DSH 技能注册表
  （`ctx.skills.registerProvider`）把技能挂进 Harness。npm 包里**不携带**任何上游技能文件。
- **只上上游发布清单里的技能。** 读取仓库的发布清单 `.claude-plugin/plugin.json`（当前 27 个技能），
  完全忽略 `skills/misc/`、`skills/in-progress/`、`skills/deprecated/`。
- **统一加 `mp-` 前缀。** 上游的 `tdd` 变成 `mp-tdd`，上游技能不可能覆盖你自己的同名技能。技能正文里
  互相引用的技能名也会改写成带前缀的名字，所以 `mp-implement` 仍然能让 agent 去加载 `mp-tdd`。
- **自动同步。** 启动后不久做一次后台同步，之后每 `syncIntervalHours`（默认 24 小时）一次。同步是串行的；
  失败的同步保留上一份可用镜像；镜像按 commit sha 存放，切换是原子的。
- **可以统一管理。** `manage_mattpocock_skills` 列出全部镜像技能，并可逐个启用/停用 —— 无需重启、无需改文件，
  且该开关在后续同步后依然生效。
- **离线可用。** 启动时若无网络，插件直接暴露上一次镜像的版本（首次运行时为空），并把错误记录在状态文件里。

## 环境要求

- DSH `0.2.0-rc.2` 及以上（本插件基于该版本的 skill-provider API）。
- Node.js `^22.19.0 || >=24.0.0`。
- 同步时需要能访问 `api.github.com` 与 `codeload.github.com`（**不需要** `git`）。

## 安装

### 从 npm 安装（推荐）

```bash
dsh plugin --profile <profile> add dsh-mattpocock-skills
```

也可以直接在 DSH 的插件管理界面 / 插件市场里安装。本包自带 bundle patch，挂载是自动的。

### 手动挂载（发布前也可用）

插件只需要能被 profile 解析到，并在 profile 的补丁层
`~/.dsh/profiles/<profile>/cordis.patch.yml` 里被引用一次：

```yaml
- insert:
    - id: mattpocock-skills
      name: dsh-mattpocock-skills
      config:
        syncIntervalHours: 12
```

如果直接指向本地工作副本：

```yaml
- insert:
    - id: mattpocock-skills
      name: 'file:///D:/dsh工作区/dsh-mattpocock-skills/lib/index.js'
```

重启 DSH（或让 loader 热加载补丁）后，镜像来的技能会以 `mp-*` 出现在技能目录里。

## 配置

所有配置项都可选，写在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 中该插件自己的条目上：

```yaml
- id: mattpocock-skills
  name: dsh-mattpocock-skills
  config:
    categories: ["engineering"]
    disabledSkills: ["retro"]
    syncIntervalHours: 12
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `repo` | `mattpocock/skills` | 上游仓库，`owner/name`。 |
| `ref` | `main` | 要镜像的分支、tag 或 commit sha。 |
| `token` | `''` | 可选的 GitHub token：提高 API 限额，也可用于私有镜像。 |
| `manifestPath` | `.claude-plugin/plugin.json` | 上游发布清单，决定暴露哪些技能。 |
| `skillsRoot` | `skills` | 仓库中存放技能目录的路径。 |
| `useUpstreamManifest` | `true` | 严格按发布清单暴露（设为 `false` 则扫描所有 `*/SKILL.md`）。 |
| `categories` | `[]` | 只暴露指定分类（如 `engineering`、`productivity`）；留空表示全部。 |
| `namePrefix` | `mp-` | 所有技能名前缀。 |
| `rank` | `700` | 提供方优先级，数值越小越优先；700 让镜像技能排在 bundled（600）与文件系统（100–500）技能之后。 |
| `source` | `custom` | 技能目录中显示的来源标签。 |
| `rewriteSkillReferences` | `true` | 把正文中的技能引用改写成带前缀的名字。 |
| `honourInvocationFlags` | `true` | 保留上游的 `disable-model-invocation` / `user-invocable` 标记；设为 `false` 则所有技能都允许模型调用。 |
| `defaultEnabled` | `true` | 未单独设置开关时的初始启用状态。 |
| `enabledSkills` | `[]` | 当 `defaultEnabled` 为 `false` 时使用的白名单。 |
| `disabledSkills` | `[]` | 在白名单之后生效的黑名单。 |
| `syncOnStart` | `true` | 启动时若尚无镜像，先同步一次。 |
| `autoSync` | `true` | 是否后台自动保持镜像最新。 |
| `initialSyncDelaySeconds` | `10` | 首次后台同步前的延迟。 |
| `syncIntervalHours` | `24` | 后台同步周期。 |
| `keepVersions` | `3` | 保留多少个 commit 的镜像以便回滚。 |
| `maxArchiveBytes` | `33554432` | 下载归档的大小上限（32 MiB）。 |
| `timeoutMs` | `30000` | 单次网络请求超时。 |
| `dataDir` | `''` | 镜像存放位置；留空表示 `<DSH_HOME>/plugin-data/dsh-mattpocock-skills`。 |
| `registerTools` | `true` | 是否注册下面两个 agent 工具。 |

## 技能目录与调用方式

镜像包含上游正式发布的 27 个技能，统一加上 `mp-` 前缀（`mp-tdd`、`mp-codebase-design` 等）。
正文除技能间引用会被改写为带前缀的名字外保持原样；`[tests.md](tests.md)` 这类同级文件链接
照旧可用，因为整个技能目录都会被镜像。

上游用 `disable-model-invocation: true` 把 27 个技能中的 16 个标记为「由用户触发」
（`ask-matt`、`grill-me`、`grill-with-docs`、`handoff`、`implement`、`implement-spec`、
`improve-codebase-architecture`、`retro`、`setup-matt-pocock-skills`、`teach`、
`to-questionnaire`、`to-spec`、`to-tickets`、`triage`、`wait-what`、`wayfinder`）。默认保持
上游语义：这 16 个只由用户调用，其余 11 个模型也可自动加载。若希望 27 个都允许模型调用，把
`honourInvocationFlags` 设为 `false`。

在 patch 层修改插件**配置**会即时生效；修改插件自身的 `lib/*.js` 需要重启 DSH。

## 工具

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `sync_mattpocock_skills` | `force`（布尔，默认 `false`）、`dryRun`（布尔，默认 `false`） | 检查上游并镜像新版本。返回上一次与最新的 commit、是否有变化，以及逐技能的差异（新增 / 删除 / 变更 / 校验失败）。`force` 会重新落盘当前 commit，`dryRun` 只报告不动镜像。 |
| `manage_mattpocock_skills` | `action`：`list` / `status` / `enable` / `disable` / `enable_all` / `disable_all` / `reset`；`skills`：技能名数组 | 查看并开关镜像技能。`reset` 清除运行时开关。技能名可以不带 `mp-` 前缀。 |

两个工具都会立即刷新在线技能目录，因此开关在下一轮对话就生效，无需重启 DSH。

## 工作原理

```
上游 commit sha ──► codeload tar.gz ──► 解包 ──► 缓存 ──► 技能候选 ──► DSH 技能目录
                (api.github.com)     (skills/…)  (versions/<sha>)   (mp- 前缀)
```

1. **解析版本。** 通过 GitHub API 取 `ref` 的最新 commit（失败时回退到 `info/refs`），只有上游真的动了才同步。
2. **下载与解包。** 用 `codeload.github.com` 下载该 commit 的归档，gunzip 后由零依赖的 tar 解析器解到
   `versions/<sha>/`。会剥掉归档根目录，只保留发布清单与技能树；不安全的路径（绝对路径、`..`、符号链接）
   直接丢弃。
3. **校验。** 每个 `SKILL.md` 必须带 YAML frontmatter、`name` 为 kebab-case、`description` 非空。校验失败的
   技能只出现在同步结果里，不会暴露给模型。
4. **提供技能。** provider 以 `mp-*` 列出已启用的技能，`get` 时返回文件正文，并把 `resourceBase` 指向镜像目录，
   因此技能正文引用的旁路文件（`tests.md`、`mocking.md`、各类格式说明与模板）都能在技能旁边被解析到。

### 数据目录

```
<DSH_HOME>/plugin-data/dsh-mattpocock-skills/
├── state.json                  # 当前 commit、运行时开关、上次同步结果、技能索引
└── versions/
    └── <commit-sha>/
        ├── inventory.json      # 该版本的技能索引
        └── skills/<category>/<skill>/SKILL.md …
```

整个目录删掉也没关系：下次同步会重新建好。

## 上游与许可

- 上游：<https://github.com/mattpocock/skills> —— MIT，© Matt Pocock。见 [NOTICE.md](./NOTICE.md)。
- 本插件**不分发**任何上游内容：它在用户机器上于运行时从 GitHub 下载，镜像文件保存在
  `<DSH_HOME>/plugin-data/` 下，在那里遵循上游的 MIT 许可。
- 本插件自身代码为 MIT，见 [LICENSE](./LICENSE)。

## 开发

```bash
npm test        # 38 个单元测试（tar 解析、清单/frontmatter 解析、store、sync、provider、插件装配）
npm run smoke   # 对真实上游仓库做端到端同步，写入 .scratch/smoke
```

smoke 脚本只写 `./.scratch/smoke`，不会碰你已安装的镜像。
