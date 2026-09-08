/**
 * 批量数据源（目录/上传/Excel/CSV/JSON）——batch/index.vue 拆分（第一批①b）。
 *
 * 来源三选一：目录扫描（electronAPI）、文件上传（ExcelProcessor 解析
 * xlsx；csv/json 文本流）、JSON 直接输入。产出统一 batchData 行 +
 * availableFields 可映射字段清单（与 inputs 映射联动）。逐字搬移自
 * index.vue（行为零变化），依赖经 deps 注入。
 */
import { ref, computed } from 'vue'
import { showError, showSuccess } from '@/utils'
import { ExcelProcessor } from '@/utils/excel-utils'

const fileTypes = {
  images: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico'],
  videos: ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.wmv', '.flv'],
  audios: ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'],
  texts: ['.txt', '.md', '.json', '.csv', '.xml', '.yml', '.yaml', '.ini', '.log'],
  documents: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'],
}

/**
 * @param deps { batchData, directoryFiles } —— 批量数据与目录文件列表由页面持有
 */
export function useBatchSource(deps) {
  const { batchData } = deps

  const directoryFiles = ref([])
  const selectedSourceType = ref('directory')
  const directoryPath = ref('')
  const fileFilter = ref('all') // 文件过滤选项
  const uploadedFiles = ref([])
  const jsonInput = ref('[]')

  const filteredDirectoryFiles = computed(() => {
    if (fileFilter.value === 'all') {
      return directoryFiles.value
    }
    const filterMap = {
      files: (file) => !file.isDirectory,
      directories: (file) => file.isDirectory,
      images: (file) =>
        !file.isDirectory && fileTypes.images.some((ext) => file.name.toLowerCase().endsWith(ext)),
      videos: (file) =>
        !file.isDirectory && fileTypes.videos.some((ext) => file.name.toLowerCase().endsWith(ext)),
      audios: (file) =>
        !file.isDirectory && fileTypes.audios.some((ext) => file.name.toLowerCase().endsWith(ext)),
      texts: (file) =>
        !file.isDirectory && fileTypes.texts.some((ext) => file.name.toLowerCase().endsWith(ext)),
      documents: (file) =>
        !file.isDirectory &&
        fileTypes.documents.some((ext) => file.name.toLowerCase().endsWith(ext)),
    }
    return directoryFiles.value.filter(filterMap[fileFilter.value] || (() => true))
  })

  // 选择目录
  async function selectDirectory() {
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.ArtifyLab.selectFile()
        if (!result) return
        directoryPath.value = result
        await scanDirectory(result)
      } else {
        showError('electronNotAvailable')
      }
    } catch (error) {
      console.error('选择目录失败:', error)
      showError('selectDirectoryFailed')
    }
  }

  // 扫描目录
  async function scanDirectory(path) {
    try {
      if (window.electronAPI) {
        const files = await window.electronAPI.ArtifyLab.scanFolder(path)
        const mapped = files.map((file) => ({
          name: file.fileName,
          path: file.fullPath,
          size: file.size,
          type: file.isDirectory ? 'directory' : 'file',
          extension: file.extension,
          isDirectory: file.isDirectory,
          lastModified: file.lastModified,
          relativePath: file.relativePath,
        }))
        directoryFiles.value = mapped
        // 生成批量数据
        generateBatchDataFromFiles()
      }
    } catch (error) {
      console.error('扫描目录失败:', error)
      showError('scanDirectoryFailed')
    }
  }

  // 从文件生成批量数据
  function generateBatchDataFromFiles() {
    batchData.value = filteredDirectoryFiles.value.map((file) => ({
      fileName: file.name,
      filePath: file.path,
      fileSize: file.size,
      fileType: file.type,
      fileExtension: file.extension,
      // file.extension 来自 path.extname，含前导点（'.jpg'），按其本身长度截断即可，
      // 之前用 length+1 会多砍一个字符（photo.jpg → phot）。
      fileNameWithoutExt: file.extension ? file.name.slice(0, -file.extension.length) : file.name,
      isDirectory: file.isDirectory,
      lastModified: file.lastModified,
      relativePath: file.relativePath,
    }))
    deps.updateAvailableFields()
  }

  // 文件上传前校验：Excel 走 ExcelProcessor 校验；其他只收 csv/json 文本
  function beforeFileUpload(file) {
    // 使用ExcelProcessor验证文件
    if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
      const validation = ExcelProcessor.validateExcelFile(file)
      if (!validation.isValid) {
        showError(validation.errors[0])
        return false
      }
    } else {
      // 其他文件类型验证
      const isValidType = ['text/csv', 'application/json'].includes(file.type)
      if (!isValidType) {
        showError('unsupportedFileType')
        return false
      }

      const isLt10M = file.size / 1024 / 1024 < 10
      if (!isLt10M) {
        showError('fileTooLarge')
        return false
      }
    }

    return false // 阻止自动上传，手动处理
  }

  // 处理文件上传
  async function handleFileUpload(file) {
    try {
      if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
        // Excel文件处理
        await parseExcelFile(file)
      } else {
        // 其他文件处理
        const reader = new FileReader()
        reader.onload = (e) => {
          const content = e.target.result
          parseFileContent(content, file.name)
        }
        reader.readAsText(file)
      }
    } catch (error) {
      console.error('文件处理失败:', error)
      showError('fileProcessingFailed')
    }
  }

  // 解析文件内容
  function parseFileContent(content, fileName) {
    try {
      let data = []

      if (fileName.endsWith('.json')) {
        data = JSON.parse(content)
      } else if (fileName.endsWith('.csv')) {
        data = parseCSV(content)
      } else {
        showError('unsupportedFileType')
        return
      }

      if (Array.isArray(data)) {
        batchData.value = data
        deps.updateAvailableFields()
        showSuccess('fileParsedSuccessfully')
      } else {
        showError('invalidDataFormat')
      }
    } catch (error) {
      console.error('解析文件失败:', error)
      showError('fileParseFailed')
    }
  }

  // 解析Excel文件
  async function parseExcelFile(file) {
    try {
      // 使用ExcelProcessor解析文件
      const result = await ExcelProcessor.parseExcelFile(file, {
        sheetIndex: 0, // 使用第一个工作表
        headerRow: 0, // 第一行作为表头
        dataStartRow: 1, // 从第二行开始读取数据
        maxRows: 10000, // 最大读取10000行
        includeEmptyRows: false, // 不包含空行
        dateFormat: 'YYYY-MM-DD', // 日期格式
        numberFormat: 'string', // 数字转换为字符串
      })

      batchData.value = result.data
      deps.updateAvailableFields()
      showSuccess('excelFileParsedSuccessfully')

      // 显示文件信息
      console.log('Excel文件解析成功:', {
        sheetName: result.sheetName,
        totalRows: result.totalRows,
        headers: result.headers,
      })

      return result.data
    } catch (error) {
      console.error('Excel文件解析失败:', error)
      showError('excelParseFailed')
      throw error
    }
  }

  // 解析CSV
  function parseCSV(content) {
    const lines = content.split('\n')
    const headers = lines[0].split(',').map((h) => h.trim())
    const data = []

    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim()) {
        const values = lines[i].split(',').map((v) => v.trim())
        const item = {}
        headers.forEach((header, index) => {
          item[header] = values[index] || ''
        })
        data.push(item)
      }
    }

    return data
  }

  // 移除文件
  function removeFile(file) {
    const index = uploadedFiles.value.findIndex((f) => f.uid === file.uid)
    if (index > -1) {
      uploadedFiles.value.splice(index, 1)
    }
  }

  // JSON输入处理
  function handleJsonChange(value) {
    jsonInput.value = value
    try {
      const data = JSON.parse(value)
      if (Array.isArray(data)) {
        batchData.value = data
        deps.updateAvailableFields()
      }
    } catch (error) {
      // JSON格式错误时不更新数据
    }
  }

  return {
    selectedSourceType,
    directoryPath,
    directoryFiles,
    fileFilter,
    uploadedFiles,
    jsonInput,
    filteredDirectoryFiles,
    selectDirectory,
    scanDirectory,
    generateBatchDataFromFiles,
    beforeFileUpload,
    handleFileUpload,
    removeFile,
    handleJsonChange,
    fileTypes,
  }
}
