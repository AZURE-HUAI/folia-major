# Automix — 智能过渡

播放器的「混音过渡」开关背后的全部实现。功能本身的代码全在这个目录里，目录外只剩下四个接线点。

单元测试在 `test/unit/automix/`，与本目录一一对应。

## 一次换歌，从上往下走一遍

| 层 | 文件 | 回答的问题 |
| --- | --- | --- |
| 证据 | `trackProfile.ts` | 这个音频文件本身是什么样：BPM（全曲 + 尾段）、小节线在哪、响度（LUFS）、两端各自的调、三段频谱占比、段落边界表、前奏到哪结束、结尾是收还是断 |
| | `signalAnalysis.ts` | 上下都要用的数学：K 计权、自相关测速、重拍相位、交叉曲线、分频段曲线、平衡修正 |
| | `profileService.ts` | 字节从哪来、什么时候允许下载、测完存哪。`trackProfile` 的不纯的那一半 |
| | `deckAnalyser.ts` | 正在响的那一路此刻是什么样：实时电平（同样 K 计权）、下一个拍点在哪 |
| | `deckClock.ts` | 这一路**此刻播到第几秒**——把 `currentTime` 的台阶拟合成直线，精度进到毫秒 |
| 决策 | `musicalTime.ts` | 音乐的单位：拍/小节/乐句取整、两首歌速度关系（含二倍等价）、入场点对齐 |
| | `transitionChooser.ts` | 这两首歌该用四种接法里的哪一种（beatCut / bassSwap / tailRide / plainBlend），以及音色差多少、要不要抛回声 |
| | `transitionPlanner.ts` | 这一次接多长、落在出场曲的哪个位置、下一首从第几秒进 |
| 执行 | `automixSession.ts` | 状态机 `idle → armed → fading`，以及每一步反悔的条件 |
| | `crossfadeGraph.ts` | Web Audio 那一半：两路 deck 的节点链、增益曲线、三段频谱各自的接缝、回声抛掷 |
| | `tempoBend.ts` | 把出场曲拉到进场曲的速度上（`playbackRate` + `preservesPitch`，音高由浏览器保住） |
| 绑定 | `useAutomixDecks.ts` | React 外壳：两个 `<audio>`、当前是哪一路、每一路渲染什么 src |

除 `useAutomixDecks.ts` 外都不碰 React 也不碰 DOM，所以测试不需要音频设备。

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

同一条规则的第二次违反不是靠新接法混进来的，是靠**乘法**：调性冲突 ×0.4、速度太远 ×0.5、
进场曲满电平 ×0.6，每一条单独看都对，乘起来是 0.12——那不叫「短一点」，那是一次没人写下来的硬切。
`chooseTransitionStyle` 里 `lengthScale` 现在有 0.25 的地板（一个乐句的四分之一 = 一小节，
还听得出是「接」的最短跨度）。任何新的长度系数都要记得它是要跟别人相乘的。

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

**过渡长度是算出来的，25 秒只是天花板。** `AUTOMIX_MAX_OVERLAP_SEC` 曾经是 8，注释写着「再长就不像
一首歌在结束了」——那是品味不是测量，而且它比任何测出来的东西都更常成为瓶颈（日志里出现过 63 秒尾奏
配 8 秒前奏被一刀切到 8 秒）。现在长度是「一个乐句（16 拍）× 各项系数 → 按乐句/小节/拍取整」，
天花板只负责拦截，且拦截时是往下退整数个小节，不是把上限本身当答案。放开到 25 的前提是 E4（LUFS）
和 E5（重叠期留 1.5dB 余量）都已经落地——长重叠撑得住，才敢放长。

**「控制进场 deck 什么时候起播」是个假问题，真问题是「知道它现在播到哪」。** 这条推翻了文档里两版
P10/P9 的方向。淡入淡出是排在 AudioContext 时钟上的，本来就是采样级精确；不精确的是「排的时候两首
歌各自在第几秒」。`currentTime` 是个台阶，但台阶底下是一条**严格的直线**（斜率就是 playbackRate），
所以拟合一秒的读数就能把相位压到毫秒以下——`deckClock.ts`。有了它，对齐不再需要 AudioBufferSourceNode、
不需要整首解码进内存、不需要重写进度条/拖动/MediaSession，UI 和状态机一行没动。
残留的半个量化步（约 10ms）是常数偏置，两路 deck 同样偏，做差就没了。

**变速只弯出场曲，永远不弯进场曲。** DJ 的做法是反过来的（不能动全场正在跳的那张），但我们这里出场曲
只剩几秒、没有未来可以错，而进场曲马上要被听三分钟——弯了它就得在它独自响着的时候把速度扳回来，
那是整段过渡里唯一没有东西可以遮掩的时刻。

**音高不用我们保，`<audio>` 自己会保——这里曾经保了两遍。** 一度有个 150 行的 WSOLA worklet，
前提是「`playbackRate` 是个重采样器，所以只缺把音高除回去这一半」。这句话对重采样器成立，对媒体元素
不成立：`preservesPitch` 规范默认就是 `true`，元素**自带**时间伸缩器（视频站的倍速用的就是它），
而且它跑在浏览器的音频渲染层，在 Web Audio 取音之前。于是校正被做了两遍——0.75 倍速的出场曲
被整体升高了四度。日志里那句 `outgoing at 0.750x in tune` 的 `in tune` 是假的。
删掉 worklet 之后一起没了的还有：一个独立打包 chunk、音频线程上每 21ms 一次的相关性搜索、
以及每路 deck 永久背着的 20ms 延迟。`tempoBend.ts` 现在只剩两个属性赋值，`preservesPitch` 每次都写，
不吃默认值——它是这条链唯一的前提，写出来才算数。

**速度差的上限是 8%，不是 25%，而且这个数字挡的主要是测速错误。** 8% 是黑胶唱机变调推杆的行程，
那不是硬件冷知识：是几十年里人们在真观众面前反复试出来的「一张唱片还听得出是它自己」的边界。
25% 被推翻有两个理由，第二个更要命——0.25 是 5:4、0.33 是 4:3，正好是自相关锁错谐波时返回的比值。
所以幅度最大的那些弯曲，恰恰不是最需要对齐的配对，而是**其中一首测错了**的配对：最大代价，零收益。
8% 以下任何谐波错误都够不着，落在带内的就是真的。

**一首歌被测了两次速度，两次不一致时答案是「不知道」，不是「取后测的那次」。**
`settledBpm(bpm, outroBpm)`：全曲测一次、末 30 秒再测一次，正常情况取后者（收尾渐慢时它才是过渡贴着的
那个速度）。但日志里有 `92 BPM (123 at the end)`、`136 BPM (86 at the end)`——差三分之一到一半，
没有歌会这样慢下来，那是测速在两个窗口里锁到了不同谐波。同一个量测两次对不上，意味着**没测出来**，
返回 null：网格退回实时探针，速度不弯。原来的 `outroBpm ?? bpm` 是无条件相信后测的那次。

**证据层不认识 React，也不认识播放器。** 新增测量只加在 `trackProfile.ts` / `signalAnalysis.ts`，
它们只接受数组和数字。要拿新数据做决策，改 `transitionChooser` 或 `transitionPlanner`，
不要让执行层直接去读档案。

**改 AudioParam 上正在跑的曲线要用 `cancelAndHoldAtTime`。** `cancelScheduledValues` 只删还没开始的
事件，一条已经在跑的 `setValueCurveAtTime` 会活下来，接着往它的区间里写任何事件都是 NotSupportedError
——而 `settle` 是所有结局的必经之路，中途暂停就会踩到。`crossfadeGraph` 里的 `releaseParam` 是唯一
入口。曲线本身不要在 `startAt` 那一刻再补一个 `setValueAtTime`，引擎会判定重叠。
