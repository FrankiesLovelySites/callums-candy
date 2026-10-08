import { stdin, stdout } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { createAdminUser } from "../server.mjs";

if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
	console.error("Run this command in an interactive terminal so the admin password can be entered securely.");
	process.exit(1);
}

const terminal = createInterface({ input: stdin, output: stdout });

function readHiddenPassword() {
	stdout.write("Admin password (minimum 12 characters): ");
	stdin.setRawMode(true);
	stdin.resume();
	return new Promise((resolve, reject) => {
		let password = "";
		const onKey = (character, key) => {
			if (key.ctrl && key.name === "c") {
				stdin.off("keypress", onKey);
				stdin.setRawMode(false);
				stdout.write("\n");
				reject(new Error("Password entry cancelled."));
			} else if (key.name === "return" || key.name === "enter") {
				stdin.off("keypress", onKey);
				stdin.setRawMode(false);
				stdout.write("\n");
				resolve(password);
			} else if (key.name === "backspace") {
				password = password.slice(0, -1);
			} else if (!key.ctrl && !key.meta && character.length === 1 && character >= " ") {
				password += character;
			}
		};
		stdin.on("keypress", onKey);
	});
}

try {
	const username = await terminal.question("Admin username: ");
	terminal.close();
	emitKeypressEvents(stdin);
	const password = await readHiddenPassword();
	await createAdminUser(username, password);
	console.log("Admin account created. Keep these credentials private.");
} catch (error) {
	console.error(`Could not create admin account: ${error.message}`);
	process.exitCode = 1;
} finally {
	terminal.close();
}
