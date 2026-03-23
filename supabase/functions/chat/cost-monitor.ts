const DAILY_LIMIT = 500; // max calls per day
const COST_ALERT_THRESHOLD = 5.0; // USD

let dailyCount = 0;
let dailyDate = "";
let estimatedCost = 0;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function resetIfNewDay(): void {
  const today = todayStr();
  if (today !== dailyDate) {
    dailyCount = 0;
    estimatedCost = 0;
    dailyDate = today;
  }
}

export async function checkDailyLimit(): Promise<boolean> {
  resetIfNewDay();
  return dailyCount < DAILY_LIMIT;
}

export async function recordCost(model: string, responseChars: number): Promise<void> {
  resetIfNewDay();
  dailyCount++;

  const costPerCall = model.includes("haiku") ? 0.002 : 0.005;
  estimatedCost += costPerCall;

  if (estimatedCost > COST_ALERT_THRESHOLD) {
    console.warn(
      `[COST ALERT] Daily LLM cost estimate: $${estimatedCost.toFixed(2)} (${dailyCount} calls)`
    );
  }
}
