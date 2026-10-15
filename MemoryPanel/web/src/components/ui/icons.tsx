/**
 * Panel icon set (lucide), sized to 16px by default to match body text.
 * Pass `size` to override.
 */
import type { ComponentType } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ClipboardPaste,
  CodeXml,
  Ellipsis,
  FileText,
  Folder,
  FolderOpen,
  Info,
  Layers,
  LayoutPanelTop,
  Loader2,
  Paperclip,
  Sparkles,
  Star,
  XCircle,
  Globe,
  LayoutDashboard,
  LayoutGrid,
  LibraryBig,
  List,
  Lock,
  MessagesSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Upload,
  User,
  Users,
  Wrench,
  X,
  type LucideProps,
} from 'lucide-react';

function sized(Icon: ComponentType<LucideProps>, name: string) {
  const C = (props: LucideProps) => <Icon size={16} aria-hidden {...props} />;
  C.displayName = name;
  return C;
}

export const ArrowLeftIcon = sized(ArrowLeft, 'ArrowLeftIcon');
export const ChevronDownIcon = sized(ChevronDown, 'ChevronDownIcon');
export const ChevronRightIcon = sized(ChevronRight, 'ChevronRightIcon');
export const PasteIcon = sized(ClipboardPaste, 'PasteIcon');
export const CodeIcon = sized(CodeXml, 'CodeIcon');
export const FolderOpenIcon = sized(FolderOpen, 'FolderOpenIcon');
export const GlobeIcon = sized(Globe, 'GlobeIcon');
export const DashboardIcon = sized(LayoutDashboard, 'DashboardIcon');
export const AnalyticsIcon = sized(BarChart3, 'AnalyticsIcon');
export const GridViewIcon = sized(LayoutGrid, 'GridViewIcon');
export const LibraryIcon = sized(LibraryBig, 'LibraryIcon');
export const ListViewIcon = sized(List, 'ListViewIcon');
export const LockIcon = sized(Lock, 'LockIcon');
export const ChatIcon = sized(MessagesSquare, 'ChatIcon');
export const EditIcon = sized(Pencil, 'EditIcon');
export const AddIcon = sized(Plus, 'AddIcon');
export const RefreshIcon = sized(RefreshCw, 'RefreshIcon');
export const SearchIcon = sized(Search, 'SearchIcon');
export const SettingsIcon = sized(Settings, 'SettingsIcon');
export const DeleteIcon = sized(Trash2, 'DeleteIcon');
export const UploadIcon = sized(Upload, 'UploadIcon');
export const UserIcon = sized(User, 'UserIcon');
export const TeamIcon = sized(Users, 'TeamIcon');
export const ToolsIcon = sized(Wrench, 'ToolsIcon');
export const CloseIcon = sized(X, 'CloseIcon');
export const CheckIcon = sized(Check, 'CheckIcon');
export const CheckCircleIcon = sized(CheckCircle2, 'CheckCircleIcon');
export const CloseCircleIcon = sized(XCircle, 'CloseCircleIcon');
export const TimeIcon = sized(Clock, 'TimeIcon');
export const MoreIcon = sized(Ellipsis, 'MoreIcon');
export const FileIcon = sized(FileText, 'FileIcon');
export const FolderIcon = sized(Folder, 'FolderIcon');
export const InfoCircleIcon = sized(Info, 'InfoCircleIcon');
export const LayersIcon = sized(Layers, 'LayersIcon');
export const AppIcon = sized(LayoutPanelTop, 'AppIcon');
export const AttachIcon = sized(Paperclip, 'AttachIcon');
export const StarIcon = sized(Star, 'StarIcon');
/** Filled star (built-in / featured markers). */
export const StarFilledIcon = (props: LucideProps) => <Star size={16} fill="currentColor" aria-hidden {...props} />;
/** Sparkle (AI actions such as ingest). */
export const SparkleIcon = sized(Sparkles, 'SparkleIcon');
export const ChartBarIcon = AnalyticsIcon;
/** Spinning loader. */
export const LoadingIcon = (props: LucideProps) => <Loader2 size={16} aria-hidden className="wf-spin" {...props} />;
