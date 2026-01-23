import { useState, useMemo, useRef } from 'react';
import Papa from 'papaparse';
import { Upload, AlertCircle, RefreshCw, DollarSign, Calculator, Loader2, Printer, TrendingUp, Landmark, Download } from 'lucide-react';
import { format, parse, min, max, subDays, parseISO } from 'date-fns';
import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useReactToPrint } from 'react-to-print';

// --- Types ---

// Gain/Loss CSV Row
interface GainLossRow {
  Symbol: string;
  Description: string;
  Quantity: string;
  'Date Acquired': string;
  'Date Sold': string;
  'Sales Proceeds': string;
  'Adjust Cost': string;
  'WS Loss Disallowed': string;
  'Net Gain/Loss': string;
  '% Gain/Loss': string;
  'Wash Sales': string;
}

// Transaction History CSV Row (for Dividends)
interface HistoryRow {
  Symbol: string;
  Action: string;
  Description: string;
  TradeDate: string; // YYYY-MM-DD
  Amount: string; // Net Amount
}

interface JpyTransaction {
  id: number;
  symbol: string;
  quantity: number;
  dateAcquired: Date | null;
  dateSold: Date;
  proceedsUsd: number;
  costUsd: number;
  wsDisallowed: number;
  // Exchange Rates
  rateAcquired: number;
  rateSold: number;
  // JPY Values
  proceedsJpy: number;
  costJpy: number;
  gainLossJpy: number;
  // Meta
  isWashSale: boolean;
  notes: string;
}

interface DividendTransaction {
  id: number;
  symbol: string;
  date: Date;
  amountNetUsd: number; // Net received
  taxUsd: number;       // Withheld tax extracted from description
  amountGrossUsd: number; // Gross = Net + Tax
  rate: number;
  amountGrossJpy: number;
  taxJpy: number;
  amountNetJpy: number;
  description: string;
}

interface InterestTransaction {
  id: number;
  symbol: string;
  date: Date;
  amountNetUsd: number;
  rate: number;
  amountNetJpy: number;
  description: string;
}

interface RatesMap {
  [date: string]: number; // "YYYY-MM-DD" -> Rate
}

type FileType = 'GAIN_LOSS' | 'HISTORY' | 'UNKNOWN';

// --- Utils ---

function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

function parseMoney(str: string): number {
  if (!str) return 0;
  return parseFloat(str.replace(/[^0-9.-]/g, ''));
}

// Try multiple date formats
function parseDateAny(str: string): Date | null {
  if (!str || str.toLowerCase().includes('var')) return null;

  // Format 1: MM/dd/yyyy (GainLoss CSV)
  if (str.includes('/')) {
    try { return parse(str, 'MM/dd/yyyy', new Date()); } catch (e) { }
  }

  // Format 2: YYYY-MM-DD (History CSV)
  if (str.includes('-')) {
    try { return parseISO(str); } catch (e) { }
  }

  return null;
}

function getRateForDate(date: Date, rates: RatesMap): { rate: number; dateUsed: string } {
  let current = date;
  let attempts = 0;
  while (attempts < 10) {
    const key = format(current, 'yyyy-MM-dd');
    if (rates[key]) {
      return { rate: rates[key], dateUsed: key };
    }
    current = subDays(current, 1);
    attempts++;
  }
  return { rate: 0, dateUsed: 'N/A' };
}

// Extract tax from description like "NON-RES TAX WITHHELD $1.23"
function extractTaxFromDescription(desc: string): number {
  const match = desc.match(/TAX WITHHELD\s+\$?([0-9,.]+)/i);
  if (match && match[1]) {
    return parseMoney(match[1]);
  }
  return 0;
}

// --- Components ---

const SummaryCard = ({ title, amount, subtext, type = 'neutral', icon: Icon, className }: { title: string, amount: string, subtext?: string, type?: 'positive' | 'negative' | 'neutral', icon?: any, className?: string }) => (
  <div className={cn("bg-white p-6 rounded-xl shadow-sm border border-slate-200 flex items-start justify-between", className)}>
    <div>
      <p className="text-sm font-medium text-slate-500 mb-1">{title}</p>
      <p className={cn(
        "text-2xl font-bold tracking-tight",
        type === 'positive' && "text-green-600",
        type === 'negative' && "text-red-600",
        type === 'neutral' && "text-slate-900"
      )}>
        {amount}
      </p>
      {subtext && <p className="text-xs text-slate-400 mt-1">{subtext}</p>}
    </div>
    {Icon && (
      <div className={cn("p-3 rounded-lg",
        type === 'positive' ? "bg-green-50 text-green-600" :
          type === 'negative' ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-500"
      )}>
        <Icon className="w-6 h-6" />
      </div>
    )}
  </div>
);

// --- Printable Report Component ---
const ReportTemplate = ({
  year,
  totals,
  grouped,
  dividends,
  interests,
  ref
}: {
  year: number,
  totals: any,
  grouped: [string, { summary: any }][],
  dividends: DividendTransaction[],
  interests: InterestTransaction[],
  ref: React.RefObject<HTMLDivElement | null>
}) => {
  const dividendTotal = dividends.reduce((acc, d) => ({
    gross: acc.gross + d.amountGrossJpy,
    tax: acc.tax + d.taxJpy,
    net: acc.net + d.amountNetJpy,
    grossUsd: acc.grossUsd + d.amountGrossUsd
  }), { gross: 0, tax: 0, net: 0, grossUsd: 0 });

  const interestTotal = interests.reduce((acc, i) => ({
    net: acc.net + i.amountNetJpy,
    netUsd: acc.netUsd + i.amountNetUsd
  }), { net: 0, netUsd: 0 });

  return (
    <div ref={ref} className="p-12 bg-white text-slate-900 font-serif print-content">
      <style>{`
        @media print {
          .print-content { display: block !important; }
          @page { size: A4; margin: 20mm; }
          .page-break { page-break-before: always; }
        }
      `}</style>

      {/* Title */}
      <div className="text-center mb-12 border-b-2 border-slate-900 pb-4">
        <h1 className="text-2xl font-bold mb-2">令和{year - 2018}年分 株式等の取引報告書</h1>
        <p className="text-sm text-slate-600">（特定口座以外の外国証券取引分）</p>
      </div>

      {/* Basic Info */}
      <div className="flex justify-between mb-8 text-sm">
        <div className="space-y-1">
          <p><strong>証券会社:</strong> Firstrade Securities Inc.</p>
          <p><strong>通貨:</strong> 米ドル (USD) → 日本円 (JPY)</p>
          <p><strong>換算基準:</strong> TTM (Frankfurter API参照)</p>
        </div>
        <div className="text-right space-y-1">
          <p><strong>作成日:</strong> {format(new Date(), 'yyyy年MM月dd日')}</p>
          <p><strong>対象期間:</strong> {year}年1月1日 〜 {year}年12月31日</p>
        </div>
      </div>

      {/* --- Section 1: Capital Gains --- */}
      {totals.count > 0 && (
        <div className="mb-12">
          <h2 className="text-lg font-bold mb-4 border-l-4 border-slate-900 pl-3 flex items-center gap-2">
            1. 株式等の譲渡損益 <span className="text-sm font-normal text-slate-500">(一般株式等)</span>
          </h2>
          {/* Summary Table */}
          <table className="w-full border-collapse border border-slate-400 mb-8">
            <thead className="bg-slate-100">
              <tr>
                <th className="border border-slate-400 p-3 text-left w-1/3">区分</th>
                <th className="border border-slate-400 p-3 text-right">金額 (円)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-slate-400 p-3">総収入金額 (A) <span className="text-xs text-slate-500 block">譲渡対価の額</span></td>
                <td className="border border-slate-400 p-3 text-right text-lg">{Math.floor(totals.proceeds).toLocaleString()}</td>
              </tr>
              <tr>
                <td className="border border-slate-400 p-3">総取得費 (B) <span className="text-xs text-slate-500 block">取得費及び譲渡費用</span></td>
                <td className="border border-slate-400 p-3 text-right text-lg">{Math.floor(totals.cost).toLocaleString()}</td>
              </tr>
              <tr className="bg-slate-50 font-bold">
                <td className="border border-slate-400 p-3">差引金額 (A - B) <span className="text-xs text-slate-500 block">譲渡所得等の金額</span></td>
                <td className={cn(
                  "border border-slate-400 p-3 text-right text-xl",
                  totals.gainLoss < 0 && "text-red-700"
                )}>
                  {totals.gainLoss < 0 ? "▲ " : ""}{Math.abs(Math.floor(totals.gainLoss)).toLocaleString()}
                </td>
              </tr>
            </tbody>
          </table>

          {/* Details Table */}
          <h3 className="text-md font-bold mb-2 text-slate-700">銘柄別内訳 (譲渡)</h3>
          <table className="w-full border-collapse border border-slate-300 text-sm mb-8">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                <th className="border border-slate-300 p-2 text-left">銘柄</th>
                <th className="border border-slate-300 p-2 text-right">収入金額 (円)</th>
                <th className="border border-slate-300 p-2 text-right">取得費 (円)</th>
                <th className="border border-slate-300 p-2 text-right">損益金額 (円)</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(([symbol, data]) => (
                <tr key={symbol}>
                  <td className="border border-slate-300 p-2 font-mono font-bold">{symbol}</td>
                  <td className="border border-slate-300 p-2 text-right">{Math.floor(data.summary.proceeds).toLocaleString()}</td>
                  <td className="border border-slate-300 p-2 text-right">{Math.floor(data.summary.cost).toLocaleString()}</td>
                  <td className={cn(
                    "border border-slate-300 p-2 text-right font-medium",
                    data.summary.gainLoss < 0 && "text-red-700"
                  )}>
                    {data.summary.gainLoss < 0 ? "▲ " : ""}{Math.abs(Math.floor(data.summary.gainLoss)).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --- Section 2: Dividends --- */}
      {dividends.length > 0 && (
        <div className={totals.count > 10 ? "page-break" : "mt-12"}>
          <h2 className="text-lg font-bold mb-4 border-l-4 border-slate-900 pl-3 flex items-center gap-2">
            2. 配当所得 <span className="text-sm font-normal text-slate-500">(配当控除または外国税額控除用)</span>
          </h2>

          <table className="w-full border-collapse border border-slate-400 mb-6">
            <thead className="bg-slate-100">
              <tr>
                <th className="border border-slate-400 p-3 text-left">区分</th>
                <th className="border border-slate-400 p-3 text-right">金額 (円)</th>
                <th className="border border-slate-400 p-3 text-right text-xs text-slate-500 font-normal">参考(USD)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-slate-400 p-3">配当収入総額 (税込)</td>
                <td className="border border-slate-400 p-3 text-right text-lg">{Math.floor(dividendTotal.gross).toLocaleString()}</td>
                <td className="border border-slate-400 p-3 text-right text-slate-500">$ {dividendTotal.grossUsd.toFixed(2)}</td>
              </tr>
              <tr>
                <td className="border border-slate-400 p-3">外国所得税額</td>
                <td className="border border-slate-400 p-3 text-right text-lg">{Math.floor(dividendTotal.tax).toLocaleString()}</td>
                <td className="border border-slate-400 p-3 text-right text-slate-500"></td>
              </tr>
              <tr className="bg-slate-50 font-bold">
                <td className="border border-slate-400 p-3">差引受取金額</td>
                <td className="border border-slate-400 p-3 text-right text-xl">{Math.floor(dividendTotal.net).toLocaleString()}</td>
                <td className="border border-slate-400 p-3 text-right text-slate-500"></td>
              </tr>
            </tbody>
          </table>

          <h3 className="text-md font-bold mb-2 text-slate-700">受取配当金明細</h3>
          <table className="w-full border-collapse border border-slate-300 text-xs">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                <th className="border border-slate-300 p-1 text-left">入金日</th>
                <th className="border border-slate-300 p-1 text-left">銘柄</th>
                <th className="border border-slate-300 p-1 text-right">レート</th>
                <th className="border border-slate-300 p-1 text-right">配当総額(USD)</th>
                <th className="border border-slate-300 p-1 text-right">外国税(USD)</th>
                <th className="border border-slate-300 p-1 text-right bg-slate-50">配当総額(円)</th>
                <th className="border border-slate-300 p-1 text-right bg-slate-50">外国税(円)</th>
              </tr>
            </thead>
            <tbody>
              {dividends.map(d => (
                <tr key={d.id}>
                  <td className="border border-slate-300 p-1">{format(d.date, 'MM/dd')}</td>
                  <td className="border border-slate-300 p-1 font-bold">{d.symbol}</td>
                  <td className="border border-slate-300 p-1 text-right text-slate-500">{d.rate.toFixed(2)}</td>
                  <td className="border border-slate-300 p-1 text-right">{d.amountGrossUsd.toFixed(2)}</td>
                  <td className="border border-slate-300 p-1 text-right text-red-600">-{d.taxUsd.toFixed(2)}</td>
                  <td className="border border-slate-300 p-1 text-right font-medium bg-slate-50">{Math.floor(d.amountGrossJpy).toLocaleString()}</td>
                  <td className="border border-slate-300 p-1 text-right text-red-700 bg-slate-50">-{Math.floor(d.taxJpy).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --- Section 3: Interest --- */}
      {interests.length > 0 && (
        <div className="mt-12">
          <h2 className="text-lg font-bold mb-4 border-l-4 border-slate-900 pl-3 flex items-center gap-2">
            3. 利子所得 <span className="text-sm font-normal text-slate-500">(一般利子等)</span>
          </h2>

          <table className="w-full border-collapse border border-slate-400 mb-6">
            <thead className="bg-slate-100">
              <tr>
                <th className="border border-slate-400 p-3 text-left">区分</th>
                <th className="border border-slate-400 p-3 text-right">金額 (円)</th>
                <th className="border border-slate-400 p-3 text-right text-xs text-slate-500 font-normal">参考(USD)</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-slate-50 font-bold">
                <td className="border border-slate-400 p-3">受取利子総額</td>
                <td className="border border-slate-400 p-3 text-right text-xl">{Math.floor(interestTotal.net).toLocaleString()}</td>
                <td className="border border-slate-400 p-3 text-right text-slate-500">$ {interestTotal.netUsd.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>

          <h3 className="text-md font-bold mb-2 text-slate-700">受取利子明細</h3>
          <table className="w-full border-collapse border border-slate-300 text-xs">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                <th className="border border-slate-300 p-1 text-left">入金日</th>
                <th className="border border-slate-300 p-1 text-left">項目</th>
                <th className="border border-slate-300 p-1 text-right">レート</th>
                <th className="border border-slate-300 p-1 text-right">受取額(USD)</th>
                <th className="border border-slate-300 p-1 text-right bg-slate-50">受取額(円)</th>
              </tr>
            </thead>
            <tbody>
              {interests.map(i => (
                <tr key={i.id}>
                  <td className="border border-slate-300 p-1">{format(i.date, 'MM/dd')}</td>
                  <td className="border border-slate-300 p-1 font-bold">{i.description.substring(0, 30)}...</td>
                  <td className="border border-slate-300 p-1 text-right text-slate-500">{i.rate.toFixed(2)}</td>
                  <td className="border border-slate-300 p-1 text-right">{i.amountNetUsd.toFixed(2)}</td>
                  <td className="border border-slate-300 p-1 text-right font-medium bg-slate-50">{Math.floor(i.amountNetJpy).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer */}
      <div className="mt-12 pt-8 border-t border-slate-300 text-xs text-slate-500 text-center leading-relaxed">
        <p>※本計算書は、Firstradeから発行されたCSVに基づき、取引日の為替レート(欧州中央銀行参照TTM)を用いて日本円換算したものです。</p>
        <p>※確定申告の添付書類として使用する場合は、内容を十分にご確認の上、ご自身の責任においてご使用ください。</p>
      </div>
    </div>
  );
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'capital' | 'dividend' | 'interest'>('capital');

  // Data States
  const [gainLossData, setGainLossData] = useState<JpyTransaction[]>([]);
  const [dividendData, setDividendData] = useState<DividendTransaction[]>([]);
  const [interestData, setInterestData] = useState<InterestTransaction[]>([]);

  // Raw CSV States
  const [gainLossRaw, setGainLossRaw] = useState<GainLossRow[] | null>(null);
  const [dividendRaw, setDividendRaw] = useState<HistoryRow[] | null>(null);
  const [interestRaw, setInterestRaw] = useState<HistoryRow[] | null>(null);

  // Exchange Rates
  const [rates, setRates] = useState<RatesMap>({});

  // UI States
  const [loading, setLoading] = useState(false);
  const [fetchingRates, setFetchingRates] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // UseRef for Printing
  /* UseRef for Printing */
  const contentRef = useRef<HTMLDivElement>(null);
  const handlePrint = useReactToPrint({
    contentRef,
    documentTitle: `Firstrade_Report_${selectedYear}`
  });

  // --- Filtering & Calculations ---

  const filteredGainLoss = useMemo(() => {
    return gainLossData.filter(t => t.dateSold.getFullYear() === selectedYear);
  }, [gainLossData, selectedYear]);

  const filteredDividends = useMemo(() => {
    return dividendData.filter(t => t.date.getFullYear() === selectedYear);
  }, [dividendData, selectedYear]);

  const filteredInterests = useMemo(() => {
    return interestData.filter(t => t.date.getFullYear() === selectedYear);
  }, [interestData, selectedYear]);

  // Aggregation for Capital Gains
  const groupedGainLoss = useMemo(() => {
    const groups: { [key: string]: { summary: { proceeds: number, cost: number, gainLoss: number, proceedsUsd: number, costUsd: number, gainLossUsd: number }, transactions: JpyTransaction[] } } = {};
    filteredGainLoss.forEach(t => {
      if (!groups[t.symbol]) groups[t.symbol] = { summary: { proceeds: 0, cost: 0, gainLoss: 0, proceedsUsd: 0, costUsd: 0, gainLossUsd: 0 }, transactions: [] };
      groups[t.symbol].transactions.push(t);
      groups[t.symbol].summary.proceeds += t.proceedsJpy;
      groups[t.symbol].summary.cost += t.costJpy;
      groups[t.symbol].summary.gainLoss += t.gainLossJpy;
      groups[t.symbol].summary.proceedsUsd += t.proceedsUsd;
      groups[t.symbol].summary.costUsd += t.costUsd;
      groups[t.symbol].summary.gainLossUsd += (t.proceedsUsd - t.costUsd);
    });
    return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredGainLoss]);

  const totalsGainLoss = useMemo(() => {
    return filteredGainLoss.reduce((acc, t) => ({
      proceeds: acc.proceeds + t.proceedsJpy,
      cost: acc.cost + t.costJpy,
      gainLoss: acc.gainLoss + t.gainLossJpy,
      proceedsUsd: acc.proceedsUsd + t.proceedsUsd,
      costUsd: acc.costUsd + t.costUsd,
      gainLossUsd: acc.gainLossUsd + (t.proceedsUsd - t.costUsd),
      wsDisallowed: acc.wsDisallowed + t.wsDisallowed,
      count: acc.count + 1
    }), { proceeds: 0, cost: 0, gainLoss: 0, proceedsUsd: 0, costUsd: 0, gainLossUsd: 0, wsDisallowed: 0, count: 0 });
  }, [filteredGainLoss]);

  // Aggregation for Dividends
  const totalsDividend = useMemo(() => {
    return filteredDividends.reduce((acc, d) => ({
      amountGrossJpy: acc.amountGrossJpy + d.amountGrossJpy,
      taxJpy: acc.taxJpy + d.taxJpy,
      amountNetJpy: acc.amountNetJpy + d.amountNetJpy,
      amountGrossUsd: acc.amountGrossUsd + d.amountGrossUsd,
      count: acc.count + 1
    }), { amountGrossJpy: 0, taxJpy: 0, amountNetJpy: 0, amountGrossUsd: 0, count: 0 });
  }, [filteredDividends]);

  // Available Years
  const availableYears = useMemo(() => {
    const years = new Set<number>();
    gainLossData.forEach(t => years.add(t.dateSold.getFullYear()));
    dividendData.forEach(t => years.add(t.date.getFullYear()));
    interestData.forEach(t => years.add(t.date.getFullYear()));
    if (years.size === 0) return [new Date().getFullYear()];
    return Array.from(years).sort((a, b) => b - a);
  }, [gainLossData, dividendData, interestData]);


  // --- File Processing ---

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      console.log("File dropped:", files[0].name);
      processFile(files[0]);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset inputs so the same file can be selected again
    e.target.value = '';

    setLoading(true);
    setError(null);
    console.log("File selected:", file.name);
    processFile(file);
  };

  const processFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) { setError("ファイルが空です"); setLoading(false); return; }

      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      // Find Header Line
      const headerIndex = lines.findIndex(line => {
        const lower = line.toLowerCase();
        return lower.startsWith('symbol') || lower.startsWith('"symbol"');
      });

      if (headerIndex === -1) {
        console.error("Header not found. First few lines:", lines.slice(0, 3));
        setError("ヘッダー(Symbol)が見つかりません。正しいCSVか確認してください。");
        setLoading(false);
        return;
      }

      const headerLine = lines[headerIndex].toLowerCase();
      let fileType: FileType = 'UNKNOWN';

      console.log("Header detected:", headerLine);

      if (headerLine.includes('sales proceeds')) {
        fileType = 'GAIN_LOSS';
      } else if (headerLine.includes('action') && headerLine.includes('amount')) {
        fileType = 'HISTORY';
      }

      console.log("Detected File Type:", fileType);

      const cleanCsv = lines.slice(headerIndex).join('\n');

      Papa.parse(cleanCsv, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          console.log("Parsed rows:", results.data.length);
          if (fileType === 'GAIN_LOSS') {
            const rows = (results.data as GainLossRow[]).filter(r => r.Symbol && !r.Symbol.startsWith('Total'));
            if (rows.length === 0) { setError("有効なデータが見つかりませんでした(Gain/Loss)"); }
            else {
              setGainLossRaw(rows);
              setActiveTab('capital');
              if (Object.keys(rates).length > 0) calculateGainLoss(rows, rates);
            }
          } else if (fileType === 'HISTORY') {
            const rows = (results.data as HistoryRow[]).filter(r => r.Action === 'Dividend');
            console.log("Dividend rows found:", rows.length);
            if (rows.length === 0) { setError("配当データ(Action=Dividend)が見つかりませんでした"); }
            else {
              setDividendRaw(rows);
              setActiveTab('dividend');
              const interestRows = (results.data as HistoryRow[]).filter(r => r.Action === 'Interest');
              if (interestRows.length > 0) {
                setInterestRaw(interestRows);
              }

              if (Object.keys(rates).length > 0) {
                calculateDividends(rows, rates);
                if (interestRows.length > 0) calculateInterests(interestRows, rates);
              }
            }
          } else {
            // Fallback Logic if headers unclear
            const firstRow = results.data[0] as any;
            if (firstRow && firstRow['Sales Proceeds']) {
              setGainLossRaw((results.data as GainLossRow[]).filter(r => r.Symbol));
              setActiveTab('capital');
            } else if (firstRow && firstRow['Action']) {
              const divRows = (results.data as HistoryRow[]).filter(r => r.Action === 'Dividend');
              const intRows = (results.data as HistoryRow[]).filter(r => r.Action === 'Interest');

              if (divRows.length === 0 && intRows.length === 0) {
                setError("CSVは読み込めましたが、配当(Dividend)も利子(Interest)も含まれていません");
              } else {
                if (divRows.length > 0) {
                  setDividendRaw(divRows);
                  setActiveTab('dividend');
                }
                if (intRows.length > 0) {
                  setInterestRaw(intRows);
                  if (divRows.length === 0) setActiveTab('interest');
                }
              }
            } else {
              setError("不明なCSV形式です。Firstradeの Gain/Loss または History ファイルを使用してください。");
            }
          }
          setLoading(false);
        },
        error: (err: Error) => { setError("パースエラー: " + err.message); setLoading(false); }
      });
    };
    reader.readAsText(file);
  };

  const fetchExchangeRates = async () => {
    if (!gainLossRaw && !dividendRaw) return;
    setFetchingRates(true);
    setError(null);

    try {
      const dates: Date[] = [];

      // Collect dates from GainLoss
      gainLossRaw?.forEach(row => {
        const d1 = parseDateAny(row['Date Acquired']);
        const d2 = parseDateAny(row['Date Sold']);
        if (d1) dates.push(d1);
        if (d2) dates.push(d2);
      });

      // Collect dates from Dividends
      dividendRaw?.forEach(row => {
        const d = parseDateAny(row.TradeDate);
        if (d) dates.push(d);
      });

      // Collect dates from Interests
      interestRaw?.forEach(row => {
        const d = parseDateAny(row.TradeDate);
        if (d) dates.push(d);
      });

      if (dates.length === 0) throw new Error("日付データが見つかりません");

      const minDate = min(dates);
      const maxDate = max(dates);
      const fetchStart = format(subDays(minDate, 10), 'yyyy-MM-dd');
      const fetchEnd = format(maxDate, 'yyyy-MM-dd');

      const res = await fetch(`https://api.frankfurter.app/${fetchStart}..${fetchEnd}?from=USD&to=JPY`);
      if (!res.ok) throw new Error("為替レート取得失敗");

      const data = await res.json();
      const ratesMap: RatesMap = {};
      Object.entries(data.rates).forEach(([date, values]: [string, any]) => {
        ratesMap[date] = values.JPY;
      });

      setRates(ratesMap);

      // Calculate Both
      if (gainLossRaw) calculateGainLoss(gainLossRaw, ratesMap);
      if (dividendRaw) calculateDividends(dividendRaw, ratesMap);
      if (interestRaw) calculateInterests(interestRaw, ratesMap);

      // Auto Set Year
      const years = new Set<number>();
      dates.forEach(d => years.add(d.getFullYear()));
      if (years.size > 0) setSelectedYear(Math.max(...Array.from(years)));

    } catch (err: any) {
      setError(err.message || "レート取得エラー");
    } finally {
      setFetchingRates(false);
    }
  };

  const calculateGainLoss = (rows: GainLossRow[], currentRates: RatesMap) => {
    const calculated = rows.map((row, idx) => {
      const dateSold = parseDateAny(row['Date Sold']);
      if (!dateSold) return null;
      let dateAcquired = parseDateAny(row['Date Acquired']);
      const isVarious = !dateAcquired && row['Date Acquired']?.toLowerCase().includes('var');
      if (!dateAcquired) dateAcquired = dateSold;

      const proceedsUsd = parseMoney(row['Sales Proceeds']);
      const costUsd = parseMoney(row['Adjust Cost']);
      const wsDisallowed = parseMoney(row['WS Loss Disallowed']);

      const rateSoldData = getRateForDate(dateSold, currentRates);
      const rateAcqData = getRateForDate(dateAcquired, currentRates);
      const proceedsJpy = Math.floor(proceedsUsd * rateSoldData.rate);
      const costJpy = Math.floor(costUsd * rateAcqData.rate);

      return {
        id: idx,
        symbol: row.Symbol,
        quantity: parseFloat(row.Quantity),
        dateAcquired,
        dateSold,
        proceedsUsd,
        costUsd,
        wsDisallowed,
        rateAcquired: rateAcqData.rate,
        rateSold: rateSoldData.rate,
        proceedsJpy,
        costJpy,
        gainLossJpy: proceedsJpy - costJpy,
        isWashSale: row['Wash Sales'] === 'YES',
        notes: isVarious ? '取得日不明(Various)' : (rateSoldData.rate === 0 ? 'レートエラー' : '')
      } as JpyTransaction;
    }).filter(Boolean) as JpyTransaction[];
    setGainLossData(calculated);
  };

  const calculateDividends = (rows: HistoryRow[], currentRates: RatesMap) => {
    const calculated = rows.map((row, idx) => {
      const date = parseDateAny(row.TradeDate);
      if (!date) return null;

      const amountNetUsd = parseMoney(row.Amount);
      const taxUsd = extractTaxFromDescription(row.Description);
      const amountGrossUsd = amountNetUsd + taxUsd;

      const rateData = getRateForDate(date, currentRates);

      return {
        id: idx,
        symbol: row.Symbol,
        date,
        amountNetUsd,
        taxUsd,
        amountGrossUsd,
        rate: rateData.rate,
        amountGrossJpy: Math.floor(amountGrossUsd * rateData.rate),
        taxJpy: Math.floor(taxUsd * rateData.rate),
        amountNetJpy: Math.floor(amountNetUsd * rateData.rate),
        description: row.Description
      } as DividendTransaction;
    }).filter(Boolean) as DividendTransaction[];
    setDividendData(calculated);
  };

  const calculateInterests = (rows: HistoryRow[], currentRates: RatesMap) => {
    const calculated = rows.map((row, idx) => {
      const date = parseDateAny(row.TradeDate);
      if (!date) return null;

      const amountNetUsd = parseMoney(row.Amount);
      const rateData = getRateForDate(date, currentRates);

      return {
        id: idx,
        symbol: row.Symbol,
        date,
        amountNetUsd,
        rate: rateData.rate,
        amountNetJpy: Math.floor(amountNetUsd * rateData.rate),
        description: row.Description
      } as InterestTransaction;
    }).filter(Boolean) as InterestTransaction[];
    setInterestData(calculated);
  };

  const formatCurrency = (val: number) => `¥ ${Math.floor(val).toLocaleString()}`;
  const formatUsd = (val: number) => `$ ${val.toFixed(2)}`;

  const handleDownloadCsv = () => {
    if (activeTab === 'capital') {
      if (filteredGainLoss.length === 0) return;
      const data = filteredGainLoss.map(t => ({
        Symbol: t.symbol,
        Quantity: t.quantity,
        'Date Acquired': t.dateAcquired ? format(t.dateAcquired, 'yyyy-MM-dd') : '',
        'Date Sold': format(t.dateSold, 'yyyy-MM-dd'),
        'Rate (Acq)': t.rateAcquired,
        'Rate (Sold)': t.rateSold,
        'Proceeds (USD)': t.proceedsUsd,
        'Cost (USD)': t.costUsd,
        'Gain/Loss (USD)': (t.proceedsUsd - t.costUsd).toFixed(2),
        'Proceeds (JPY)': t.proceedsJpy,
        'Cost (JPY)': t.costJpy,
        'Gain/Loss (JPY)': t.gainLossJpy,
        'Wash Sale': t.isWashSale ? 'YES' : 'NO',
        'Notes': t.notes
      }));
      const csv = Papa.unparse(data);
      const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `GainLoss_${selectedYear}_Calculated.csv`;
      link.click();
    } else if (activeTab === 'dividend') {
      if (filteredDividends.length === 0) return;
      const data = filteredDividends.map(d => ({
        Symbol: d.symbol,
        Date: format(d.date, 'yyyy-MM-dd'),
        Rate: d.rate,
        'Gross Amount (USD)': d.amountGrossUsd,
        'Tax (USD)': d.taxUsd,
        'Net Amount (USD)': d.amountNetUsd,
        'Gross Amount (JPY)': d.amountGrossJpy,
        'Tax (JPY)': d.taxJpy,
        'Net Amount (JPY)': d.amountNetJpy,
        'Description': d.description
      }));
      const csv = Papa.unparse(data);
      const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `Dividends_${selectedYear}_Calculated.csv`;
      link.click();
    } else {
      if (filteredInterests.length === 0) return;
      const data = filteredInterests.map(i => ({
        Symbol: i.symbol,
        Date: format(i.date, 'yyyy-MM-dd'),
        Rate: i.rate,
        'Amount (USD)': i.amountNetUsd,
        'Amount (JPY)': i.amountNetJpy,
        'Description': i.description
      }));
      const csv = Papa.unparse(data);
      const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `Interest_${selectedYear}_Calculated.csv`;
      link.click();
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 pb-20">

      {/* Hidden Report Component */}
      <div className="hidden">
        <ReportTemplate
          ref={contentRef}
          year={selectedYear}
          totals={totalsGainLoss}
          grouped={groupedGainLoss}
          dividends={filteredDividends}
          interests={filteredInterests}
        />
      </div>

      {/* Header */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-10 shadow-sm print:hidden">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 text-white p-2 rounded-lg shadow-blue-200 shadow-md">
              <Calculator className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold text-slate-800">Firstrade 確定申告アシスタント</h1>
          </div>
          {(gainLossData.length > 0 || dividendData.length > 0) && (
            <div className="flex items-center gap-4">
              <div className="relative">
                <select
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(Number(e.target.value))}
                  className="appearance-none bg-slate-100 border border-slate-200 rounded-lg py-2 pl-4 pr-8 font-semibold text-slate-700 cursor-pointer"
                >
                  {availableYears.map(y => (
                    <option key={y} value={y}>{y}年分</option>
                  ))}
                </select>
              </div>

              <button onClick={handleDownloadCsv} className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors border border-slate-200">
                <Download className="w-4 h-4" /> CSV出力
              </button>

              <button onClick={() => handlePrint()} className="flex items-center gap-2 bg-slate-800 hover:bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-md">
                <Printer className="w-4 h-4" /> 報告書作成 (PDF)
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-8 print:hidden">

        {/* Upload Section */}
        {(!gainLossData.length && !dividendData.length) && (
          <div className="text-center space-y-8 py-10 animate-in fade-in slide-in-from-bottom-8 duration-700">
            <div className="space-y-4">
              <h2 className="text-3xl font-extrabold text-slate-900">
                米国株の確定申告を<br />もっと簡単に。
              </h2>
              <p className="text-slate-500">FirstradeのCSVをドロップしてください。<br />「FT_GainLoss_xxxx.csv (譲渡損益)」と「FT_CSV_xxxx.csv (配当・利子)」の両方に対応しています。</p>
            </div>
            <div
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              className={cn(
                "max-w-xl mx-auto bg-white rounded-2xl shadow-xl border-2 border-dashed p-12 transition-all cursor-pointer group relative overflow-hidden",
                isDragging ? "border-blue-500 bg-blue-50 scale-105" : "border-slate-200 hover:border-blue-400 hover:shadow-2xl",
                loading && "opacity-50 pointer-events-none"
              )}>
              {/* Provide both input-click and drag-drop support */}
              <input type="file" accept=".csv" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-20" onChange={handleFileUpload} disabled={loading} />
              <div className="flex flex-col items-center gap-4 relative z-10 pointer-events-none">
                <div className={cn("w-20 h-20 rounded-2xl flex items-center justify-center transition-colors", isDragging ? "bg-blue-200 text-blue-700" : "bg-blue-50 text-blue-600")}>
                  {loading ? <Loader2 className="w-10 h-10 animate-spin" /> : <Upload className="w-10 h-10" />}
                </div>
                <div>
                  <h3 className="text-xl font-bold text-slate-900 mb-1">{loading ? "解析中..." : (isDragging ? "ここにドロップ！" : "CSVをドロップ")}</h3>
                  <p className="text-slate-500 text-sm">FT_GainLoss_xxxx.csv と FT_CSV_xxxx.csv</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Action Bar for Loading More Files */}
        {(gainLossRaw || dividendRaw) && !rates[format(new Date(), 'yyyy-MM-dd')] && !loading && (
          <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex justify-between items-center animate-in fade-in slide-in-from-bottom-4">
            <div className="text-sm text-slate-500">
              <span className="font-bold text-slate-700 mr-2">読み込み済み:</span>
              {gainLossRaw ? "譲渡損益 (未計算) ✅" : ""}
              {(gainLossRaw && (dividendRaw || interestRaw)) ? " / " : ""}
              {dividendRaw ? "配当 (未計算) ✅" : ""}
              {(dividendRaw && interestRaw) ? " / " : ""}
              {interestRaw ? "利子 (未計算) ✅" : ""}
            </div>
            <div className="flex gap-2">
              {(!dividendRaw || !interestRaw) && (
                <div className="relative overflow-hidden group">
                  <input type="file" accept=".csv" className="absolute inset-0 opacity-0 cursor-pointer z-10" onChange={handleFileUpload} />
                  <button className="px-4 py-2 bg-slate-100 group-hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium">History CSVを追加</button>
                </div>
              )}
              {!gainLossRaw && (
                <div className="relative overflow-hidden group">
                  <input type="file" accept=".csv" className="absolute inset-0 opacity-0 cursor-pointer z-10" onChange={handleFileUpload} />
                  <button className="px-4 py-2 bg-slate-100 group-hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium">損益CSVを追加</button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-50 text-red-700 p-4 rounded-xl flex items-center gap-3 border border-red-200 animate-in shake">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Tabs */}
        {(gainLossRaw || dividendRaw || interestRaw) && (
          <div className="flex gap-2 border-b border-slate-200">
            {gainLossRaw && (
              <button
                onClick={() => setActiveTab('capital')}
                className={cn("px-6 py-3 font-bold text-sm border-b-2 transition-colors flex items-center gap-2", activeTab === 'capital' ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700")}
              >
                <TrendingUp className="w-4 h-4" /> 譲渡損益 (Capital Gains)
              </button>
            )}
            {dividendRaw && (
              <button
                onClick={() => setActiveTab('dividend')}
                className={cn("px-6 py-3 font-bold text-sm border-b-2 transition-colors flex items-center gap-2", activeTab === 'dividend' ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700")}
              >
                <Landmark className="w-4 h-4" /> 配当所得 (Dividends)
              </button>
            )}
            {interestRaw && (
              <button
                onClick={() => setActiveTab('interest')}
                className={cn("px-6 py-3 font-bold text-sm border-b-2 transition-colors flex items-center gap-2", activeTab === 'interest' ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700")}
              >
                <div className="bg-green-100 text-green-700 p-1 rounded-sm"><DollarSign className="w-3 h-3" /></div> 利子 (Interest)
              </button>
            )}
          </div>
        )}

        {/* Placeholder if data loaded but not calculated */}
        {(gainLossRaw || dividendRaw) && Object.keys(rates).length === 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-8 text-center space-y-4">
            <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <RefreshCw className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-bold text-blue-900">データ読み込み完了！</h3>
            <button
              onClick={fetchExchangeRates}
              disabled={fetchingRates}
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-lg font-bold shadow-lg transition-transform hover:scale-105 disabled:opacity-50 disabled:pointer-events-none"
            >
              {fetchingRates ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
              {fetchingRates ? "計算中..." : "計算を開始する"}
            </button>
          </div>
        )}

        {/* --- CAPITAL GAINS VIEW --- */}
        {activeTab === 'capital' && gainLossData.length > 0 && (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2">
            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <SummaryCard title="譲渡損益 (円)" amount={formatCurrency(totalsGainLoss.gainLoss)} type={totalsGainLoss.gainLoss >= 0 ? 'positive' : 'negative'} icon={DollarSign} />
              <SummaryCard title="総収入金額 (円)" amount={formatCurrency(totalsGainLoss.proceeds)} />
              <SummaryCard title="総取得費 (円)" amount={formatCurrency(totalsGainLoss.cost)} />
              <SummaryCard title="取引件数" amount={`${totalsGainLoss.count} 件`} type='neutral' />
            </div>

            {/* Ticker List */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              {groupedGainLoss.map(([symbol, data]) => (
                <div key={symbol} className="border-b border-slate-100 last:border-0">
                  <button
                    onClick={() => setExpandedTicker(expandedTicker === symbol ? null : symbol)}
                    className="w-full flex items-center justify-between p-4 hover:bg-slate-50 text-left"
                  >
                    <div className="font-bold text-lg w-16">{symbol}</div>
                    <div className="flex-1 px-4 text-xs text-slate-400">{data.transactions.length} 件</div>
                    <div className={cn("font-bold font-mono", data.summary.gainLoss >= 0 ? "text-green-600" : "text-red-600")}>
                      {formatCurrency(data.summary.gainLoss)}
                    </div>
                  </button>
                  {/* Expanded Details */}
                  {expandedTicker === symbol && (
                    <div className="bg-slate-50 p-4 border-t border-slate-100">
                      <table className="w-full text-xs">
                        <thead className="text-slate-400 text-right"><tr><th className="text-left">日付</th><th>数量</th><th>売却額</th><th>取得費</th><th>損益</th></tr></thead>
                        <tbody>
                          {data.transactions.map(t => (
                            <tr key={t.id} className="border-b border-slate-200/50 last:border-0">
                              <td className="py-2 text-left font-mono text-slate-600">{format(t.dateSold, 'MM/dd')}</td>
                              <td className="py-2 text-right">{t.quantity}</td>
                              <td className="py-2 text-right">{t.proceedsJpy.toLocaleString()}</td>
                              <td className="py-2 text-right">{t.costJpy.toLocaleString()}</td>
                              <td className={cn("py-2 text-right font-bold", t.gainLossJpy >= 0 ? "text-green-600" : "text-red-600")}>{t.gainLossJpy.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* --- DIVIDENDS VIEW --- */}
        {activeTab === 'dividend' && dividendData.length > 0 && (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <SummaryCard title="配当収入総額 (税込)" amount={formatCurrency(totalsDividend.amountGrossJpy)} subtext={`USD: ${formatUsd(totalsDividend.amountGrossUsd)}`} />
              <SummaryCard title="外国所得税額" amount={formatCurrency(totalsDividend.taxJpy)} type="negative" />
              <SummaryCard title="差引受取金額" amount={formatCurrency(totalsDividend.amountNetJpy)} type="positive" icon={DollarSign} />
              <SummaryCard title="受取回数" amount={`${totalsDividend.count} 回`} type='neutral' />
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                  <tr>
                    <th className="p-3 text-left">入金日</th>
                    <th className="p-3 text-left">銘柄</th>
                    <th className="p-3 text-right">配当額(USD)</th>
                    <th className="p-3 text-right">外国税(USD)</th>
                    <th className="p-3 text-right bg-blue-50/50">配当額(円)</th>
                    <th className="p-3 text-right bg-blue-50/50">外国税(円)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredDividends.map(d => (
                    <tr key={d.id} className="hover:bg-slate-50">
                      <td className="p-3 font-mono text-slate-600">{format(d.date, 'yyyy/MM/dd')}</td>
                      <td className="p-3 font-bold">{d.symbol}</td>
                      <td className="p-3 text-right font-mono">{d.amountGrossUsd.toFixed(2)}</td>
                      <td className="p-3 text-right font-mono text-red-500">-{d.taxUsd.toFixed(2)}</td>
                      <td className="p-3 text-right font-bold bg-blue-50/30">{d.amountGrossJpy.toLocaleString()}</td>
                      <td className="p-3 text-right text-red-600 bg-blue-50/30">-{d.taxJpy.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* --- INTEREST VIEW --- */}
        {activeTab === 'interest' && interestData.length > 0 && (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <SummaryCard title="利子受取総額 (円)" amount={formatCurrency(filteredInterests.reduce((sum, i) => sum + i.amountNetJpy, 0))} type='positive' icon={DollarSign} />
              <SummaryCard title="受取総額 (USD)" amount={formatUsd(filteredInterests.reduce((sum, i) => sum + i.amountNetUsd, 0))} />
              <SummaryCard title="受取回数" amount={`${filteredInterests.length} 回`} type='neutral' />
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                  <tr>
                    <th className="p-3 text-left">入金日</th>
                    <th className="p-3 text-left">内容</th>
                    <th className="p-3 text-right">受取額(USD)</th>
                    <th className="p-3 text-right">レート</th>
                    <th className="p-3 text-right bg-green-50/50">受取額(円)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredInterests.map(i => (
                    <tr key={i.id} className="hover:bg-slate-50">
                      <td className="p-3 font-mono text-slate-600">{format(i.date, 'yyyy/MM/dd')}</td>
                      <td className="p-3 font-bold text-slate-700">{i.description.substring(0, 50)}{i.description.length > 50 ? '...' : ''}</td>
                      <td className="p-3 text-right font-mono">{i.amountNetUsd.toFixed(2)}</td>
                      <td className="p-3 text-right font-mono text-slate-500">{i.rate.toFixed(2)}</td>
                      <td className="p-3 text-right font-bold bg-green-50/30 text-green-700">{i.amountNetJpy.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
