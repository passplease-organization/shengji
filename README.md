# Shengji LAN

局域网升级小游戏，支持 4 人同桌、机器人补位、Docker 部署。

## 参考

- 规则参考：https://github.com/Padfoot1277/WebApp_PokerGame_Shengji/blob/main/%E7%AE%80%E7%89%88%E8%A7%84%E5%88%99.md
- 开源扑克牌组件：[@jeremywalton/playing-card](https://github.com/Jeremy-Walton/playing-card)，MIT，提供标准牌面 Web Components。本项目使用它渲染 52 张标准牌，大小王因该库不覆盖 Joker，使用本地 fallback。

## 启动

```bash
docker compose up --build
```

Docker 构建时会运行 `npm ci` 和 `npm run build`，把开源牌面组件打包到前端静态资源中。

同一局域网内访问：

```text
http://你的主机IP:3000
```

## 当前规则实现范围

- 四人固定两队：0/2 一队，1/3 一队。
- 两副牌、8 张底牌、从 2 打到 A。
- 自动发牌、定主、庄家扣底。
- 支持一圈基础改主/攻主：级牌、带同色王级牌、王对攻无主；改主者收底重扣。
- 支持主牌、副牌、常主、级牌、大小王排序。
- 支持单张、对子、拖拉机；甩牌采用保守校验，无法完全证明时拒绝。
- 轮内跟牌、吃分、底牌翻倍结算。
- 机器人可以补位并自动出牌，便于单机测试。

复杂线上约定很多，本实现优先保证完整可玩和多人同步；甩牌、改主强弱和升级幅度可继续按你的本地玩法细化。
