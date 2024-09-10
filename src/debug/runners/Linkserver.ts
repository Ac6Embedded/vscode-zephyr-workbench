import { WestRunner } from "./WestRunner";

export class Linkserver extends WestRunner {
  name = 'linkserver';
  serverStartedPattern = 'halted due to debug-request, current mode: Thread';
}