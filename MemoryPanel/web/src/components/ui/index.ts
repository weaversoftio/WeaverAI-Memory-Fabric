/**
 * WeaverAI UI kit - the panel's own component library.
 *
 * Built on Radix primitives (MIT) and lucide icons, styled by ui.css + theme tokens.
 */
import { Modal as ModalBase } from './Overlay';
import { confirmDialog } from './confirm';

export { Button, type ButtonProps, type ButtonType } from './Button';
export { Text, H3, type TextProps, type TextTheme } from './Text';
export { Copy, type CopyProps } from './Copy';
export { Tooltip, type TooltipProps, type Placement } from './Tooltip';
export {
  Card,
  Alert,
  Tag,
  Justify,
  StatusTip,
  Status,
  MetricsBoard,
  Progress,
  Avatar,
  type AlertType,
  type TagTheme,
} from './Display';
export {
  Form,
  Input,
  InputAdornment,
  SearchBox,
  Switch,
  Checkbox,
  Segment,
  DatePicker,
  Upload,
  type SegmentOption,
} from './Form';
export { Drawer, Dropdown, List, Select, type SelectOption, type SelectProps } from './Overlay';
export { Tabs, TabPanel, Pagination, Table, type TabItem, type TableColumn, type PagingQuery, type TableAddon } from './Data';
export { Guide, type GuideStep, type GuideProps } from './Guide';
export { confirmDialog, type ConfirmOptions } from './confirm';
export { UIProvider } from './UIProvider';
export { cn } from './internal';

/** Modal with an imperative `Modal.confirm()` helper. */
export const Modal = Object.assign(ModalBase, { confirm: confirmDialog });
