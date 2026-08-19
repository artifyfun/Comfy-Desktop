// Mock数据统一入口
// 集中管理所有测试和示例数据

import { generateTestApps, performanceTest } from '../utils/testData.js'
import sampleExcelData from './sample-excel-data.js'
import sampleBatchData from './sample-batch-data.json'
import sampleBatchDataCSV from './sample-batch-data.csv'
import { getMockMarketApps } from './market-apps.js'

export { generateTestApps, performanceTest, sampleExcelData, sampleBatchData, sampleBatchDataCSV, getMockMarketApps }

// 市场应用mock数据

// 统一导出所有mock数据
export const mockData = {
  apps: {
    test: generateTestApps,
    market: getMockMarketApps
  },
  batch: {
    excel: sampleExcelData,
    json: sampleBatchData,
    csv: sampleBatchDataCSV
  },
  performance: performanceTest
}
