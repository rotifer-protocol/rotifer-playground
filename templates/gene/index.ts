interface Input {
  input: string;
}

interface Output {
  output: string;
}

export async function express(input: Input): Promise<Output> {
  return {
    output: `Processed: ${input.input}`,
  };
}
