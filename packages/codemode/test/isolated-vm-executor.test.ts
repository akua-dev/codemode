import { IsolatedVMExecutor } from "../src/executor/isolated-vm.js";
import { executorContract } from "./executor-contract.js";

executorContract(
  "IsolatedVMExecutor",
  (opts) => new IsolatedVMExecutor(opts),
);
