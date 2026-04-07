export async function express(input: { name: string }): Promise<{ greeting: string }> {
  return { greeting: "Hello, " + input.name + "! Welcome to Rotifer Protocol." };
}
