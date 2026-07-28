import * as echarts from "echarts/core";
import { LineChart, BarChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkPointComponent,
  DataZoomComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

let registered = false;

export function ensureEcharts(): typeof echarts {
  if (!registered) {
    echarts.use([
      LineChart,
      BarChart,
      GridComponent,
      TooltipComponent,
      LegendComponent,
      MarkPointComponent,
      DataZoomComponent,
      CanvasRenderer,
    ]);
    registered = true;
  }
  return echarts;
}
