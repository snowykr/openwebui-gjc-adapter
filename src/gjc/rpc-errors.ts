export class GjcRpcRunnerError extends Error {
	readonly command: string;

	constructor(command: string, message: string) {
		super(`GJC RPC ${command} failed: ${message}`);
		this.name = "GjcRpcRunnerError";
		this.command = command;
	}
}
