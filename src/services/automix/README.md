# Automix — 智能过渡

播放器的「混音过渡」开关背后的全部实现。功能本身的代码全在这个目录里，目录外只剩下四个接线点。

单元测试在 `test/unit/automix/`，与本目录一一对应。

## 一次换歌，从上往下走一遍

| 层 | 文件 | 回答的问题 |
| --- | --- | --- |
| 证据 | `trackProfile.ts` | 这个音频文件本身是什么样：BPM、响度、调性、前奏到哪结束、结尾是收还是断 |
| | `signalAnalysis.ts` | 上下都要用的数学：RMS、自相关测速、交叉曲线、平衡修正 |
| | `profileService.ts` | 字节从哪来、什么时候允许下载、测完存哪。`trackProfile` 的不纯的那一半 |
| | `deckAnalyser.ts` | 正在响的那一路此刻是什么样：实时电平、下一个拍点在哪 |
| 决策 | `transitionChooser.ts` | 这两首歌该用四种接法里的哪一种（beatCut / bassSwap / tailRide / plainBlend） |
| | `transitionPlanner.ts` | 这一次接多长、落在出场曲的哪个位置 |
| 执行 | `automixSession.ts` | 状态机 `idle → armed → fading`，以及每一步反悔的条件 |
| | `crossfadeGraph.ts` | Web Audio 那一半：两路 deck 的节点链、增益曲线、低频交接 |
| 绑定 | `useAutomixDecks.ts` | React 外壳：两个 `<audio>`、当前是哪一路、每一路渲染什么 src |

前八个文件不碰 React 也不碰 DOM，所以测试不需要音频设备。`useAutomixDecks.ts` 是唯一带 React 的一个。

## 目录外的接线点

| 谁 | 用了什么 | 为什么 |
| --- | --- | --- |
| `src/App.tsx` | `useAutomixDecks`、`clearTrackProfileRuntime` | 渲染两个 `<audio>`，把事件转进来；切换音源商时清运行时缓存 |
| `src/hooks/usePlaybackAudioBridge.ts` | `rampGain`、`AutomixDeckChain`、`autoplayHeld` | 播放桥拥有节点链上 ReplayGain 那一级；过渡待命期间它得压住自动播放 |
| `src/services/prefetchService.ts` | `ensureTrackProfile` | 预取下几首时顺手把它们测了 |
| `src/stores/useSettingsUiStore.ts` | `automixEnabled` | 开关本身，UI 在 `components/panelTab/controls/VolumeRow.tsx` |

## 两条要守住的线

**没有 `index.ts`，是故意的。** 依赖在目录层面是双向的：`prefetchService` 调 `profileService`
去测曲子，而 `useAutomixDecks` 又回头读 `prefetchService` 的歌词缓存。现在两条边落在不同文件上，
所以没有循环导入；一旦收进一个 barrel，它们就会合并成一个真的环。目录本身就是边界。

**「装好下一首」和「开始淡入淡出」是两件事。** `automixSession` 提前
`AUTOMIX_ARM_LEAD_SEC` 秒备好过渡，这段时间里 `onAutoplayHoldChange(true)` 压住播放桥的自动播放：
deck 照常拿到 src 并缓冲，只是先不出声，到点才放。把这两件事合成一件，装载耗时就会从淡入淡出里
扣掉，规划器算多长都没用。改动这一段时先确认每条退出路径都会解压——`settle` 是所有结局的必经之路。

**启发式只决定「怎么接」，不决定「接不接」。** 曾经有第五种接法 `gapless`：同专辑相邻、两端都
满电平，就用一个 6 毫秒的拼接直接对上，理由是唱片本来就连着。对唱片的判断没错，对开关的判断错了
——在一张从头连到尾的专辑上它吃掉了三分之二的换歌，于是听众打开「混音过渡」，听到的是什么都没发生。
现在剩下的每一种接法都是听得见的。加新接法时守住这条。

**一首歌结束的地方，不是文件结束的地方——而且有两个「结束」。** 过渡是从「歌尾」倒着排的，
「歌尾」一度读的是媒体时长，于是母带尾巴上的东西全被当成音乐排了进去。两次实测各暴露一层：

- `leadOut` / `soundingEnd`：最后一个音之后的数字静音。29 次换歌里 7 次交接时出场曲低于 -30 dBFS，
  4 次低于 -40——那不是过渡轻，是歌早就放完了。
- `bodyOut` / `bodyEnd`：静音门槛是「比**峰值**低 40 dB」，现代母带上那约等于比**音乐本身**低 30 dB。
  所以贴着 `soundingEnd` 排的过渡整段都在衰减里跑。补完上一条之后 5 次里仍有 3 次交接在 -23～-26 dBFS。

`planTransition` 的落点是这三句的最小值/最大值组合：`min(sounding - overlap, max(body, lastSung))`
——正常贴着响声末尾，衰减来得更早就从衰减顶点开始，但绝不早于唱完。`automixSession` 里放开 autoplay
的时刻和二次闸门的 `remaining` 必须读计划，不能再自己拿 duration 减一遍。head-only 档案两个字段都是
null（尾巴下载不到），那时才退回文件末尾。超过 `MAX_TRIMMED_TAIL_SEC` 的空白或衰减不算尾巴——
那是隐藏曲目或者写好的氛围尾奏，动它等于删歌。

**证据层不认识 React，也不认识播放器。** 新增测量只加在 `trackProfile.ts` / `signalAnalysis.ts`，
它们只接受数组和数字。要拿新数据做决策，改 `transitionChooser` 或 `transitionPlanner`，
不要让执行层直接去读档案。
