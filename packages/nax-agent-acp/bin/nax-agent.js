#!/usr/bin/env node
import { runCli } from "../dist/server/index.js";

process.exitCode = await runCli(process);
