#!/usr/bin/env node

import { createServer } from "./server";

async function main() {
  const app = await createServer();
  app.listen(4000, () => {
    console.log("Started", app.address());
  });
}

main();
