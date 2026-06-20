import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const createMockEnv = () =>
	({
		OPENROUTER_API_KEY: "test-key",
		SUPABASE_URL: "https://example.supabase.co",
		SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
		TELEGRAM_STATE: {
			get: async () => null,
			put: async () => undefined,
		} as unknown as KVNamespace,
	}) as Env;

const mockSupabaseState = {
	profiles: [] as Array<{ id: string; full_name: string | null; team_role: string | null }>,
	boardMembers: [] as Array<{ user_id: string }>,
	insertedTaskIds: [] as string[],
	failInsert: false,
};

vi.mock("@supabase/supabase-js", () => ({
	createClient: () => ({
		from: (table: string) => {
			if (table === "profiles") {
				return {
					select: async () => ({ data: mockSupabaseState.profiles, error: null }),
				};
			}

			if (table === "board_members") {
				return {
					select: () => ({
						eq: async () => ({ data: mockSupabaseState.boardMembers, error: null }),
					}),
				};
			}

			if (table === "tasks") {
				return {
					insert: () => ({
						select: () => ({
							single: async () => {
								if (mockSupabaseState.failInsert) {
									return {
										data: null,
										error: { message: "insert failed" },
									};
								}

								const nextId = mockSupabaseState.insertedTaskIds.shift() ?? "task-default";
								return {
									data: { id: nextId },
									error: null,
								};
							},
						}),
					}),
				};
			}

			throw new Error(`Unexpected table mock: ${table}`);
		},
	}),
}));

describe("Hello World worker", () => {
	it("responds with Hello World! (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	it("responds with Hello World! (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});
});

describe("/chat endpoint", () => {
	it("returns assignments when model and supabase responses are valid", async () => {
		const originalFetch = globalThis.fetch;
		mockSupabaseState.profiles = [
			{ id: "u1", full_name: "Ivan Backend", team_role: "backend" },
			{ id: "u2", full_name: "Nina QA", team_role: "qa" },
		];
		mockSupabaseState.boardMembers = [{ user_id: "u1" }, { user_id: "u2" }];
		mockSupabaseState.insertedTaskIds = ["t1", "t2", "t3", "t4"];
		mockSupabaseState.failInsert = false;
		const mockLlmResponse = {
			choices: [
				{
					message: {
						content:
							'[{"task":"Поднять backend API для задач"},{"task":"Написать qa тесты"},{"task":"Подготовить deploy pipeline"},{"task":"Проверить интеграцию"}]',
					},
				},
			],
		};

		globalThis.fetch = async () =>
			new Response(JSON.stringify(mockLlmResponse), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		try {
			const request = new IncomingRequest("http://example.com/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					message: "Нужно запустить новый модуль аналитики в прод",
					board_id: "11111111-1111-4111-8111-111111111111",
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(
				request,
				createMockEnv(),
				ctx,
			);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const json = await response.json<{
				assignments: Array<{
					task: string;
					assignee: { id: string; full_name: string | null; team_role: string | null };
					task_id: string;
				}>;
			}>();
			expect(Array.isArray(json.assignments)).toBe(true);
			expect(json.assignments.length).toBe(4);
			expect(json.assignments[0]?.assignee.id).toBe("u1");
			expect(json.assignments[0]?.task_id).toBe("t1");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns 400 when board_id is missing", async () => {
		const request = new IncomingRequest("http://example.com/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: "Разбей задачу на шаги",
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			createMockEnv(),
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		const json = await response.json<{ error: string }>();
		expect(json.error).toContain("board_id");
	});

	it("returns 400 when no users available for assignment", async () => {
		const originalFetch = globalThis.fetch;
		mockSupabaseState.profiles = [];
		mockSupabaseState.boardMembers = [];
		mockSupabaseState.insertedTaskIds = [];
		mockSupabaseState.failInsert = false;
		const mockLlmResponse = {
			choices: [{ message: { content: '[{"task":"Сделать API"}]' } }],
		};
		globalThis.fetch = async () =>
			new Response(JSON.stringify(mockLlmResponse), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		try {
			const request = new IncomingRequest("http://example.com/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					message: "Разбей задачу",
					board_id: "11111111-1111-4111-8111-111111111111",
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(
				request,
				createMockEnv(),
				ctx,
			);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(400);
			const json = await response.json<{ error: string }>();
			expect(json.error).toContain("No available users");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns 502 when task insert fails", async () => {
		const originalFetch = globalThis.fetch;
		mockSupabaseState.profiles = [{ id: "u1", full_name: "Ivan Backend", team_role: "backend" }];
		mockSupabaseState.boardMembers = [{ user_id: "u1" }];
		mockSupabaseState.insertedTaskIds = [];
		mockSupabaseState.failInsert = true;
		const mockLlmResponse = {
			choices: [{ message: { content: '[{"task":"Сделать backend API"}]' } }],
		};
		globalThis.fetch = async () =>
			new Response(JSON.stringify(mockLlmResponse), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		try {
			const request = new IncomingRequest("http://example.com/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					message: "Разбей задачу",
					board_id: "11111111-1111-4111-8111-111111111111",
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(
				request,
				createMockEnv(),
				ctx,
			);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(502);
			const json = await response.json<{ error: string }>();
			expect(json.error).toContain("persist task assignment");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns 502 when model response is not valid JSON", async () => {
		const originalFetch = globalThis.fetch;
		mockSupabaseState.profiles = [{ id: "u1", full_name: "Ivan Backend", team_role: "backend" }];
		mockSupabaseState.boardMembers = [{ user_id: "u1" }];
		mockSupabaseState.insertedTaskIds = ["t1"];
		mockSupabaseState.failInsert = false;
		const mockLlmResponse = {
			choices: [
				{
					message: {
						content: "это не json",
					},
				},
			],
		};

		globalThis.fetch = async () =>
			new Response(JSON.stringify(mockLlmResponse), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		try {
			const request = new IncomingRequest("http://example.com/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					message: "Разбей большую задачу на шаги",
					board_id: "11111111-1111-4111-8111-111111111111",
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(
				request,
				createMockEnv(),
				ctx,
			);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(502);
			const json = await response.json<{ error: string }>();
			expect(json.error).toContain("invalid JSON format");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("Telegram polling", () => {
	it("sends ok reply and persists next offset", async () => {
		const originalFetch = globalThis.fetch;
		const state = new Map<string, string>();
		const getSpy = vi.fn(async (key: string) => state.get(key) ?? null);
		const putSpy = vi.fn(async (key: string, value: string) => {
			state.set(key, value);
		});

		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const requestUrl = input instanceof Request ? input.url : input.toString();

			if (requestUrl.includes("/getUpdates")) {
				return new Response(
					JSON.stringify({
						ok: true,
						result: [{ update_id: 7, message: { chat: { id: 12345 } } }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (requestUrl.includes("/sendMessage")) {
				const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
					chat_id?: number;
					text?: string;
				};
				expect(body.chat_id).toBe(12345);
				expect(body.text).toBe("ok");
				return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			throw new Error(`Unexpected fetch URL: ${requestUrl}`);
		});

		globalThis.fetch = fetchMock as typeof fetch;

		try {
			const ctx = createExecutionContext();
			await worker.scheduled(
				{ cron: "* * * * *", scheduledTime: Date.now() } as ScheduledController,
				{
					TELEGRAM_BOT_TOKEN: "test-bot-token",
					TELEGRAM_STATE: {
						get: getSpy,
						put: putSpy,
					} as unknown as KVNamespace,
				} as Env,
				ctx,
			);
			await waitOnExecutionContext(ctx);

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(getSpy).toHaveBeenCalledWith("telegram_polling_offset");
			expect(putSpy).toHaveBeenCalledWith("telegram_polling_offset", "8");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
