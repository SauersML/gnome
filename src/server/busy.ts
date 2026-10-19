// Cloudflare bills a Durable Object for the wall time it is busy, so each object that runs a bee
// or waits on a paid provider keeps a monthly allowance of busy seconds in its own storage, and
// refuses that work once the month's allowance is spent. Together the allowances cap the bees'
// Cloudflare bill however many requests arrive (README, "Cost ceiling").
export class BusyAllowance {
	private readonly sql: SqlStorage;
	private readonly secondsPerMonth: number;

	constructor(sql: SqlStorage, secondsPerMonth: number) {
		this.sql = sql;
		this.secondsPerMonth = secondsPerMonth;
		sql.exec(`CREATE TABLE IF NOT EXISTS busy (month TEXT PRIMARY KEY, seconds REAL)`);
	}

	spent(): number {
		return Number(this.sql.exec(`SELECT seconds FROM busy WHERE month = ?`, month()).toArray()[0]?.seconds ?? 0);
	}

	left(): boolean {
		return this.spent() < this.secondsPerMonth;
	}

	// Runs work and charges its wall time, or returns null without running it once the month's
	// allowance is spent. On Cloudflare, Date.now() stands still while code runs and catches up at
	// the next I/O, so the end time is read after scheduler.wait(1) (a zero timer does not move it).
	async run<T>(work: () => Promise<T>): Promise<T | null> {
		if (!this.left()) return null;
		const start = Date.now();
		try {
			return await work();
		} finally {
			await (typeof scheduler === "undefined" ? new Promise((resolve) => setTimeout(resolve, 1)) : scheduler.wait(1));
			this.sql.exec(
				`INSERT INTO busy (month, seconds) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET seconds = seconds + excluded.seconds`,
				month(), (Date.now() - start) / 1000,
			);
		}
	}
}

const month = () => new Date().toISOString().slice(0, 7);
