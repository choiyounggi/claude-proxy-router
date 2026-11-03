# claude-proxy-router

이 Mac에 로그인된 Claude 계정 중 **리미트가 가장 여유로운 계정**으로 Anthropic API 요청을 대신 보내 주는
라우터입니다. 다른 Mac(Tailscale·LAN)의 Claude Code가 이 라우터를 API 주소로 쓰면, 라우터가 요청마다 계정을 골라
그 계정의 OAuth 토큰을 붙여 Anthropic에 보내고 응답(스트리밍 포함)을 그대로 돌려줍니다.

```
[Claude Code를 쓰는 Mac]                     [이 라우터 Mac]                         [Anthropic]
 Claude Code ──HTTP──▶ claude-proxy-router ──(계정 A·B·C 중 여유 있는 토큰)──▶ api.anthropic.com
  └ 스킬·MCP·훅·도구는 이 Mac에서 실행          └ 본문은 그대로, 인증 헤더만 교체
```

보내는 쪽은 짝 레포 [claude-auto-proxy](https://github.com/choiyounggi/claude-auto-proxy)로 켜고 끕니다. 둘 사이의
약속은 [PROTOCOL.md](PROTOCOL.md)에 있습니다.

## 주요 기능

- **계정 자동 탐색**: Orca 폴더형 계정(`~/Library/Application Support/orca/claude-profiles/<uuid>/home`)과 기본
  로그인(`~/.claude`). 같은 좌석(계정+조직)은 한 번만 셉니다.
- **여유 있는 계정 선택**: 요청마다 `max(5시간, 주간)` 사용률이 가장 낮은 계정으로 보냅니다(Fable 모델은 Fable 창 포함).
- **자동 넘기기**: 구독 리미트 `429`를 받은 계정은 리셋까지 빼고 같은 요청을 다음 계정으로 다시 보냅니다.
- **전부 찼을 때**: Anthropic과 같은 모양의 `429`로 답해, Claude Code에 평소처럼 "limit reached · resets …"가 뜹니다.
- **토큰 자동 갱신**: Keychain 토큰을 10초마다 다시 읽고, 만료 5분 전에 Claude Code와 같은 방식으로 갱신합니다.
- **계정 상태 조회**: `status` 명령과 `GET /_router/status`로 계정별 사용률과 "지금 이 계정으로 보낼지"를 보여 줍니다.
- **요청 본문은 손대지 않음**: 보내는 쪽 Claude Code가 만든 요청(시스템 프롬프트·도구·버전 정보)을 그대로 넘기고,
  인증 헤더와 `anthropic-beta`의 `oauth-2025-04-20`만 바꿉니다.

## 설치

macOS, Node.js 18.18 이상. 외부 의존성은 없습니다.

```sh
npm install -g claude-proxy-router
# 또는
brew install choiyounggi/tap/claude-proxy-router
```

라우터로 쓸 Mac의 Claude Code(또는 Orca 프로필)에 계정이 로그인돼 있어야 합니다.

## 빠른 시작

**1. 라우터 Mac**

```sh
claude-proxy-router onboard     # 받을 주소(Tailscale/LAN/로컬)·포트 선택 → 키 생성 → 백그라운드 시작
claude-proxy-router key         # 보내는 쪽에 넣을 주소와 키
claude-proxy-router status      # 계정별 사용률 확인
```

**2. Claude Code를 쓰는 Mac**

```sh
npm install -g claude-auto-proxy
claude-auto-proxy router onboard http://<라우터 주소>:18787 --on   # 키 입력 → 연결 확인 → 켜기
claude-auto-proxy router off                                        # 끄기
```

자세한 켜기·끄기와 상태 확인은 [claude-auto-proxy README](https://github.com/choiyounggi/claude-auto-proxy#라우터-모드)를
보세요. 도구 없이 한 번만 쓰려면 환경변수로도 됩니다.

```sh
ANTHROPIC_BASE_URL=http://100.x.y.z:18787 ANTHROPIC_AUTH_TOKEN=<라우터 키> claude
```

## 명령

| 명령 | 설명 |
|---|---|
| `onboard [--host IP] [--port N] [--install\|--no-install] [--yes]` | 받을 주소(Tailscale/LAN/로컬/전체)와 포트 선택. 포트가 사용 중이면 빈 포트를 제안. 키 생성(재실행 시 유지), 설정 저장, launchd 시작, 핑으로 응답 확인 |
| `key` | 보내는 쪽에 넣을 라우터 주소·키 |
| `status [--json]` | 계정별 5시간·주간·Fable 사용률, 토큰 상태, 제한 여부 |
| `ping <url> <key>` | 라우터 연결 확인 (보내는 쪽 온보딩과 같은 핑퐁) |
| `start` | 포그라운드 실행 (launchd·brew services가 이걸 실행) |
| `install` / `uninstall` | launchd 사용자 에이전트 등록/해제 (`io.github.choiyounggi.claude-proxy-router`) |
| `--version` / `--help` | 버전 / 도움말 |

모든 명령에 `--config PATH`를 줄 수 있습니다. Homebrew로 설치했다면 `install` 대신 `brew services start claude-proxy-router`도
됩니다(둘 중 하나만).

`status` 출력 예 (값은 예시). 상태는 라우터가 계정을 고를 때와 같은 판단(`available`)으로 `ok`, `가득 참`, `제한 ~리셋 시각`, `토큰 …` 중 하나입니다:

```
라우터 http://100.64.0.10:18787  v0.2.1  사용 가능 2/4
  account-a            5h  41%  7d  58%  fable   5%  ok  (live)
  account-b            5h  25%  7d  69%  fable   7%  ok  (live)
  account-c            5h 100%  7d  65%  fable  14%  가득 참  (headers)
  account-d            5h   0%  7d 100%  fable  27%  제한 ~2026-01-02T08:00:00.000Z  (live)
```

## 계정 사용량과 Claude Code의 `/status`·`/usage`

라우터를 거치는 Claude Code는 인증이 라우터 키뿐이라 `/status`에 계정이 나오지 않고 `/usage`에 요금제 사용량
(5시간·주간)이 나오지 않습니다. 계정별 사용량은 라우터 Mac의 `claude-proxy-router status`, 또는 보내는 쪽의
`claude-auto-proxy router status`(라우터의 `GET /_router/status`를 읽음)로 봅니다.

`/_router/status`는 계정마다 `available`·`availableForFable`(라우터가 지금 그 계정으로 보낼지)과 라우터의
`limitPct`를 함께 줍니다. 형식은 [PROTOCOL.md](PROTOCOL.md#status-per-account-view)에 있습니다.

## 설정

`~/Library/Application Support/claude-proxy-router/config.json` (권한 0600, `--config`로 변경). 모르는 키는 거부합니다.

| 키 | 기본값 | 설명 |
|---|---|---|
| `host` | `127.0.0.1` | 받을 주소 (`onboard`가 정함) |
| `port` | `18787` | 받을 포트 |
| `routerKey` | (생성) | 보내는 쪽이 붙이는 키. `x-router-key`, `x-api-key`, `Authorization: Bearer` 중 하나 |
| `upstream` | `https://api.anthropic.com` | 보낼 곳 |
| `usagePollS` | `60` | 사용량 조회 간격(초, 15 이상). 429면 `Retry-After`를 따름 |
| `limitPct` | `100` | 이 사용률 이상인 계정은 고르지 않음 |
| `tokenRefresh` | `true` | 만료 직전 토큰 자동 갱신 |
| `includeDefaultAccount` | `true` | `~/.claude` 기본 로그인 포함 |
| `profilesRoot` | Orca 경로 | Orca 계정 폴더 |

로그: `~/Library/Logs/claude-proxy-router/router.out.log`, `router.err.log`. 토큰은 로그·상태·파일 어디에도 남기지 않습니다.

## 동작 상세

- **백그라운드 점검** (10초마다): 각 계정의 Keychain 토큰을 다시 읽고(Claude Code가 갱신한 토큰 반영), 만료 5분 전이면
  갱신하고, 사용량(5시간·주간·Fable)을 `usagePollS`마다 조회합니다. 요청이 올 때는 아무것도 기다리지 않고 메모리의
  최신 상태로 바로 고릅니다.
- **계정 고르기**: `max(5시간, 주간)` 사용률이 가장 낮은 계정, 같으면 5시간 사용률이 낮은 계정. 모델 id에 `fable`이
  들어가면 Fable 주간 창까지 포함합니다. 리셋 시각이 지난 창은 0%로 봅니다. 응답의
  `anthropic-ratelimit-unified-*` 헤더로 사용률을 즉시 갱신합니다.
- **넘기기**: Anthropic이 구독 리미트 429를 주면 그 계정을 리셋까지 빼고 같은 요청을 다음 계정으로 다시 보냅니다.
  401이면 Keychain을 다시 읽어 토큰이 바뀌었을 때 한 번만 재시도합니다.
- **전부 찼을 때**: `429` + `anthropic-ratelimit-unified-status: rejected` 등의 헤더(`x-should-retry: false`)로
  답합니다. 쓸 수 있는 토큰이 하나도 없으면 `503`입니다.
- **경로 제한**: `/v1/*`만 넘기고 나머지는 `404`입니다. 보내는 쪽이 끊으면(Esc) 업스트림 요청도 끊습니다.

## 토큰 갱신과 안전장치

[claude-account-rotator](https://github.com/choiyounggi/claude-account-rotator)와 같은 방식(Claude Code 2.1.296 기준)입니다.

- Claude Code의 잠금 디렉터리(`<config dir>/.oauth_refresh.lock`, `<config dir>.lock`)를 기다리지 않고 잡습니다.
  Claude Code나 rotator가 갱신 중이면 건너뛰고 다음 점검에 다시 봅니다. 60초 넘게 안 건드린 빈 잠금은 Claude Code처럼
  버려진 것으로 보고 회수합니다.
- 잠금 안에서 Keychain을 다시 읽어, 그사이 누가 갱신했으면 그 토큰을 씁니다.
- 갱신 전에 같은 내용을 한 번 써 보고 다시 읽어 Keychain 쓰기가 되는지 확인합니다(안 되면 refresh 토큰을 쓰지 않음).
- 새 토큰은 같은 Keychain 항목에 다른 필드는 그대로 둔 채 씁니다(`security -i` 표준입력, 명령줄에 비밀 없음).
- `invalid_grant` 등 재로그인이 필요한 응답, 또는 요청이 서버에 닿은 뒤 끊긴 경우(토큰이 이미 바뀌었을 수 있음)는 Keychain
  항목이 바뀔 때까지 다시 시도하지 않습니다. 연결 전 실패(DNS·연결 거부·네트워크 없음)는 5분부터 늘려 가며 재시도합니다.
- 새 토큰을 Keychain에 못 쓰면 메모리에 들고 계속 쓰면서 쓰기를 재시도합니다(이전 refresh 토큰은 이미 무효라 버리지 않음).
  이 상태에서 라우터를 끄면 그 계정은 재로그인이 필요합니다.
- API가 401로 거절한 토큰은 Keychain에 다른 토큰이 생기거나 강제 갱신에 성공할 때까지 쓰지 않습니다.

## 문제 해결

| 증상 | 확인·조치 |
|---|---|
| 보내는 쪽에서 연결이 안 됨 | 보내는 쪽 `claude-auto-proxy router status`의 핑 결과(닿지 않음·키 거부·라우터 아님). 같은 tailnet인지, `claude-proxy-router key`의 주소·키가 맞는지 |
| 모든 계정이 `no_credential` | Keychain은 로그인한 GUI 세션에서만 읽힙니다. SSH에서 `start`를 직접 실행하지 말고 `onboard`/`install`로 launchd에 올리세요 |
| 계정이 `토큰 expired`·`토큰 rejected_401` | 그 계정으로 Claude Code(또는 Orca 프로필)에 다시 로그인하세요. 라우터가 Keychain의 새 토큰을 읽습니다 |
| Claude Code에 "limit reached"가 뜸 | 모든 계정이 리미트입니다. `status`에서 리셋 시각을 확인하세요 |
| 새 버전이 적용되지 않음 | 서비스를 다시 시작: `launchctl kickstart -k gui/$(id -u)/io.github.choiyounggi.claude-proxy-router` |

## 요구 사항과 한계

- macOS, Node.js 18.18 이상. 외부 의존성 없음.
- 평문 HTTP입니다. Tailscale이나 `127.0.0.1`처럼 사설 경로에서만 여세요. 라우터 키가 유일한 문입니다.
- 보내는 쪽 Mac에 claude.ai 로그인이 남아 있으면, 그 Claude Code는 시작할 때 계정 요청 몇 개(bootstrap, fast mode
  확인)를 그 로그인으로 직접 보냅니다. 모든 계정 요청을 라우터로 보내려면 보내는 쪽에서 로그아웃하세요
  (`claude-auto-proxy router status`가 남은 로그인을 알려 줍니다).
- 구독 OAuth 토큰을 다른 기기에서 쓰는 것은 Anthropic 이용 약관의 계정 사용 범위 안에서 본인 기기 사이에만 쓰세요.

## 개발

```sh
npm test        # node:test, 외부 의존성 없음
```

## 릴리즈

main에 푸시하면 CI(`.github/workflows/ci.yml`)가 macOS에서 Node 20·22·24로 테스트한 뒤 자동으로 릴리즈합니다.

1. 마지막 `v*` 태그 이후 커밋 메시지(Conventional Commits)로 버전을 정합니다. `feat!:`·`BREAKING CHANGE:` → major,
   `feat:` → minor, 그 밖의 커밋 → patch. `docs:`·`chore:`·`ci:`·`test:`·`style:`과 Git의 머지 커밋
   (`Merge pull request …`, `Merge branch …`)만 있으면 릴리즈하지 않습니다.
2. `package.json` 버전을 올려 커밋하고 `vX.Y.Z` 태그와 GitHub Release를 만듭니다.
3. npm에 배포합니다. 토큰 없이 npm trusted publishing(GitHub Actions OIDC)으로 인증하므로, npm 패키지 설정에 이
   저장소의 `ci.yml`이 신뢰할 게시자로 등록돼 있어야 합니다
   (`npm trust github claude-proxy-router --file ci.yml --repo choiyounggi/claude-proxy-router --allow-publish`).
4. 태그·GitHub Release·npm 중 하나가 실패하면 그 job을 다시 실행하세요. 이미 있는 것은 건너뛰고 빠진 단계만 실행합니다.

Homebrew formula는 [choiyounggi/homebrew-tap](https://github.com/choiyounggi/homebrew-tap)에 있어 직접 갱신합니다.
npm에 새 버전이 보인 뒤(배포 후 몇 분 걸림) 아래 값으로 `url`과 `sha256`을 바꿔 푸시하고, 이 저장소의
`Formula/claude-proxy-router.rb` 사본도 맞춥니다.

```sh
curl -sL https://registry.npmjs.org/claude-proxy-router/-/claude-proxy-router-<version>.tgz | shasum -a 256
```

라우터 Mac은 체크아웃에서 `git pull` 후 `launchctl kickstart -k gui/$(id -u)/io.github.choiyounggi.claude-proxy-router`로
다시 시작해야 새 버전이 적용됩니다.

## 라이선스

MIT — [LICENSE](LICENSE)
