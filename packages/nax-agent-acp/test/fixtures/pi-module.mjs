export const calls = [];
export function createBashTool(cwd, options) {
  calls.push({ cwd, options });
  return {
    name: "bash",
    label: "Bash",
    execute: (...args) => {
      calls.push(args);
      return "executed";
    },
  };
}
