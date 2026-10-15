import {
  Activity, AlarmClock, AlertTriangle, Archive, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Award, BarChart3, Battery, Bell, Bike, Book, BookOpen, Bot, Brain,
  BrainCircuit, Briefcase, Bug, Building2, Calculator, Calendar, Camera, Car, Check, CheckCircle2, ChefHat, ChevronRight, Circle, Clock, Cloud, Code2, Coffee, Coins, Compass,
  Cpu, CreditCard, Database, DollarSign, Download, Droplet, Dumbbell, Eye, File, FileText, Film, Filter, Flag, Flame, FlaskConical, Folder, Gamepad2, Gauge, Gift,
  GitBranch, Globe, GraduationCap, Hammer, Heart, HeartPulse, HelpCircle, History, Home, Hourglass, Image, Info, Key, Laptop, Layers, Layout, Leaf, Lightbulb, LineChart, Link,
  List, ListChecks, Lock, Mail, Map, MapPin, MessageCircle, Mic, Monitor, Moon, MousePointerClick, Mountain, Music, Network, Package, Palette, PenLine, Percent, Phone, PieChart,
  Plane, Play, Plug, Plus, Puzzle, Rocket, Route, Scale, School, Search, Send, Server, Settings, Shield, ShieldCheck, ShoppingCart, Smartphone, Sparkles, Star, Sun, Target,
  Terminal, Thermometer, ThumbsDown, ThumbsUp, Timer, Train, TrendingDown, TrendingUp, Trophy, Truck, User, Users, Utensils, Wallet, Wand2, Wifi, Wind, Workflow, Wrench,
  X, XCircle, Zap, type LucideIcon,
} from "lucide-react";

/** Icons a component block may name (kebab-case, as on lucide.dev). A curated set keeps the bundle small. */
export const ICONS: Record<string, LucideIcon> = {
  activity: Activity, "alarm-clock": AlarmClock, alert: AlertTriangle, "alert-triangle": AlertTriangle, warning: AlertTriangle, archive: Archive,
  "arrow-down": ArrowDown, "arrow-left": ArrowLeft, "arrow-right": ArrowRight, "arrow-up": ArrowUp, award: Award, "bar-chart": BarChart3, chart: BarChart3,
  battery: Battery, bell: Bell, bike: Bike, book: Book, "book-open": BookOpen, bot: Bot, brain: Brain, "brain-circuit": BrainCircuit, briefcase: Briefcase, bug: Bug,
  building: Building2, calculator: Calculator, calendar: Calendar, camera: Camera, car: Car, check: Check, "check-circle": CheckCircle2, "chef-hat": ChefHat,
  "chevron-right": ChevronRight, circle: Circle, clock: Clock, cloud: Cloud, code: Code2, coffee: Coffee, coins: Coins, compass: Compass, cpu: Cpu,
  "credit-card": CreditCard, database: Database, dollar: DollarSign, download: Download, droplet: Droplet, dumbbell: Dumbbell, eye: Eye, file: File,
  "file-text": FileText, film: Film, filter: Filter, flag: Flag, flame: Flame, flask: FlaskConical, folder: Folder, gamepad: Gamepad2, gauge: Gauge, gift: Gift,
  "git-branch": GitBranch, globe: Globe, "graduation-cap": GraduationCap, hammer: Hammer, heart: Heart, "heart-pulse": HeartPulse, help: HelpCircle,
  history: History, home: Home, hourglass: Hourglass, image: Image, info: Info, key: Key, laptop: Laptop, layers: Layers, layout: Layout, leaf: Leaf,
  lightbulb: Lightbulb, idea: Lightbulb, "line-chart": LineChart, link: Link, list: List, "list-checks": ListChecks, lock: Lock, mail: Mail, map: Map,
  "map-pin": MapPin, message: MessageCircle, "message-circle": MessageCircle, mic: Mic, monitor: Monitor, moon: Moon, "mouse-pointer-click": MousePointerClick,
  click: MousePointerClick, mountain: Mountain, music: Music, network: Network, package: Package, palette: Palette, pen: PenLine, percent: Percent, phone: Phone,
  "pie-chart": PieChart, plane: Plane, play: Play, plug: Plug, plus: Plus, puzzle: Puzzle, rocket: Rocket, route: Route, scale: Scale, school: School, search: Search,
  send: Send, server: Server, settings: Settings, shield: Shield, "shield-check": ShieldCheck, cart: ShoppingCart, "shopping-cart": ShoppingCart, smartphone: Smartphone,
  sparkles: Sparkles, star: Star, sun: Sun, target: Target, terminal: Terminal, thermometer: Thermometer, "thumbs-down": ThumbsDown, "thumbs-up": ThumbsUp, timer: Timer,
  train: Train, "trending-down": TrendingDown, "trending-up": TrendingUp, trophy: Trophy, truck: Truck, user: User, users: Users, utensils: Utensils, wallet: Wallet,
  wand: Wand2, wifi: Wifi, wind: Wind, workflow: Workflow, wrench: Wrench, x: X, "x-circle": XCircle, zap: Zap,
};

export const ICON_NAMES = Object.keys(ICONS);
