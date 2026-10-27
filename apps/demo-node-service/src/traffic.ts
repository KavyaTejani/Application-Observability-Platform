/**
 * Generates a realistic traffic mix against the demo store, so its telemetry is worth looking
 * at. Only run it when you want demo data; it is never started automatically (PRD §13.3).
 *
 *   npm run traffic -w @aop/demo-node-service
 */
const target = (process.env.TRAFFIC_TARGET ?? 'http://localhost:3001').replace(/\/+$/, '');
const rps = Math.max(0.1, Number(process.env.TRAFFIC_RPS ?? 5));
const durationSeconds = Math.max(1, Number(process.env.TRAFFIC_DURATION_SECONDS ?? 60));

type Step = { weight: number; run: () => Promise<Response> };
const randomId = () => String(1 + Math.floor(Math.random() * 24)); // ids 21–24 do not exist → 404

const steps: Step[] = [
  { weight: 30, run: () => fetch(`${target}/products`) },
  { weight: 40, run: () => fetch(`${target}/products/${randomId()}`) },
  {
    weight: 15,
    run: () =>
      fetch(`${target}/cart/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          Math.random() < 0.15
            ? {}
            : { productId: randomId(), quantity: 1 + Math.floor(Math.random() * 3) },
        ),
      }),
  },
  { weight: 15, run: () => fetch(`${target}/checkout`, { method: 'POST' }) },
];
const totalWeight = steps.reduce((sum, s) => sum + s.weight, 0);

function pick(): Step {
  let roll = Math.random() * totalWeight;
  for (const step of steps) {
    roll -= step.weight;
    if (roll <= 0) return step;
  }
  // Only reachable through floating-point rounding; the last step is a valid choice.
  return steps[steps.length - 1] as Step;
}

const statusCounts = new Map<string, number>();
let failures = 0;
const deadline = Date.now() + durationSeconds * 1000;

process.stdout.write(`Sending ~${rps} req/s to ${target} for ${durationSeconds}s…\n`);
const interval = setInterval(() => {
  if (Date.now() >= deadline) {
    clearInterval(interval);
    setTimeout(() => {
      process.stdout.write(
        `Done. Status classes: ${JSON.stringify(Object.fromEntries(statusCounts))}; network failures: ${failures}\n`,
      );
    }, 1000);
    return;
  }
  pick()
    .run()
    .then((res) => {
      const key = `${Math.floor(res.status / 100)}xx`;
      statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1);
      return res.arrayBuffer();
    })
    .catch(() => {
      failures++;
    });
}, 1000 / rps);
