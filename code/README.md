# dev-notes 예제 코드

글에 실은 수치를 재현하는 코드입니다. Node.js 24 이상에서 타입 표기를 지운 채 바로 실행됩니다.

- `tailLatency.ts`: [분산 아키텍처 5가지 스타일과 꼬리 지연](https://sungrinhan.github.io/dev-notes/posts/distributed-architecture-tail-latency/)의 p99 시뮬레이션. `node tailLatency.ts`, 재시도 버전은 `node tailLatency.ts --retry`. 시드 42, 요청 10만 건.
- `quantum.ts`: [아키텍처 퀀텀과 서비스 입도](https://sungrinhan.github.io/dev-notes/posts/architecture-quantum-granularity/)의 유니온 파인드 퀀텀 계산. `node quantum.ts`.
- `msaDeploy.ts`: [마이크로서비스와 독립 배포](https://sungrinhan.github.io/dev-notes/posts/microservices-independent-deployment/)의 재배포 실험. 카탈로그와 주문을 실제 프로세스로 띄워 배포 중 주문 요청 성공률을 잰다. `node msaDeploy.ts 5`(구성마다 5회, 약 2분 30초). 포트 4100~4180을 쓴다.

`tailLatency.ts`와 `quantum.ts`는 TypeScript 5.6(2026-11-25), `msaDeploy.ts`는 TypeScript 5.8(2026-11-27)에서 `tsc --noEmit --strict` 타입 검사를 통과했습니다.
