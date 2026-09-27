package com.buseong.kakaoauto;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;

/**
 * 끝말잇기용 한국어 단어 사전 (SPEC 8.6).
 *
 * 흔한 2~4글자 명사만 담는다 — 고유명사·비속어·전문용어는 넣지 않는다.
 * 라이브러리 없이 static 배열 하나로 끝낸다(의존성 0 규칙).
 *
 * 두음법칙: 끝말잇기 관례대로 ㄹ / ㄴ / ㅇ 을 서로 이어받을 수 있게 처리한다.
 *   - "고려" 다음에 "여름"(려→여), "라면" 다음에 "나비"(라→나) 가 된다.
 *   - 판정은 한글 음절 코드 계산으로 한다 (0xAC00 + (초성*21 + 중성)*28 + 종성).
 *
 * 쓰는 법
 *   WordDict.has("사과")                        // 사전에 있나
 *   WordDict.linkable("사과", "과일")            // 이어받을 수 있나 (두음법칙 포함)
 *   WordDict.nextStarting('과', used)           // '과'(또는 두음 변형)로 시작하는 미사용 단어
 */
public final class WordDict {
    private WordDict() {}

    /** 한글 음절 시작 코드 */
    private static final int BASE = 0xAC00;
    private static final int LAST = 0xD7A3;

    /** 초성 인덱스 */
    private static final int CHO_N = 2;   // ㄴ
    private static final int CHO_R = 5;   // ㄹ
    private static final int CHO_O = 11;  // ㅇ

    /** 두음법칙에서 ㅇ 으로 바뀌는 중성 (ㅑ ㅒ ㅕ ㅖ ㅛ ㅠ ㅣ) */
    private static final int[] YI = { 2, 3, 6, 7, 12, 17, 20 };

    private static final Random RND = new Random();

    /**
     * 끝말잇기 단어 목록. 실제로 쓰는 흔한 명사만.
     * (중복은 아래 static 블록에서 Set 으로 자동 정리된다)
     */
    public static final String[] WORDS = {
            // 과일 · 채소
            "사과", "포도", "수박", "참외", "딸기", "바나나", "오렌지", "자몽", "복숭아", "자두",
            "대추", "감귤", "석류", "매실", "모과", "앵두", "무화과", "파인애플", "블루베리", "키위",
            "감자", "고구마", "양파", "마늘", "생강", "고추", "오이", "상추", "배추", "시금치",
            "당근", "호박", "가지", "토마토", "버섯", "콩나물", "도라지", "더덕", "연근", "우엉",
            // 음식 · 요리
            "두부", "계란", "우유", "치즈", "버터", "요구르트", "김치", "된장", "고추장", "간장",
            "참기름", "설탕", "소금", "후추", "밀가루", "쌀밥", "국수", "라면", "만두", "김밥",
            "떡볶이", "순대", "튀김", "치킨", "피자", "햄버거", "샌드위치", "샐러드", "볶음밥", "비빔밥",
            "냉면", "칼국수", "수제비", "떡국", "송편", "잡채", "불고기", "갈비", "삼겹살", "미역국",
            "된장국", "김치찌개", "부침개", "전골", "국밥", "팥죽", "식빵", "케이크", "쿠키", "초콜릿",
            "사탕", "젤리", "빙수", "팝콘", "과자", "주스", "커피", "녹차", "홍차", "식혜",
            // 동물
            "강아지", "고양이", "토끼", "사자", "호랑이", "여우", "늑대", "사슴", "노루", "다람쥐",
            "원숭이", "코끼리", "기린", "하마", "얼룩말", "낙타", "돼지", "염소", "송아지", "병아리",
            "참새", "비둘기", "까마귀", "까치", "독수리", "부엉이", "올빼미", "제비", "갈매기", "펭귄",
            "타조", "공작", "앵무새", "개구리", "올챙이", "도마뱀", "거북", "악어", "상어", "고래",
            "돌고래", "문어", "오징어", "낙지", "새우", "조개", "전복", "멸치", "고등어", "갈치",
            "연어", "참치", "송어", "잉어", "붕어", "미꾸라지", "개미", "나비", "잠자리", "매미",
            "메뚜기", "귀뚜라미", "거미", "지렁이", "달팽이", "무당벌레", "사마귀", "애벌레", "누에", "하늘소",
            // 자연 · 날씨 · 우주
            "하늘", "구름", "바람", "서리", "안개", "이슬", "무지개", "번개", "천둥", "태양",
            "우주", "지구", "화성", "금성", "목성", "토성", "수성", "은하", "혜성", "위성",
            "바다", "호수", "개울", "폭포", "언덕", "들판", "나무", "뿌리", "씨앗", "열매",
            "줄기", "바위", "모래", "진흙", "얼음", "계곡", "동굴", "반도", "사막", "초원",
            "화산", "지진", "파도", "해변", "갯벌", "노을", "새벽", "아침", "점심", "저녁",
            "여름", "가을", "겨울", "계절", "날씨", "기온", "습도", "장마", "태풍", "폭설",
            // 집 · 살림
            "의자", "책상", "침대", "이불", "베개", "옷장", "서랍", "거울", "창문", "천장",
            "계단", "지붕", "마당", "정원", "울타리", "대문", "열쇠", "자물쇠", "시계", "달력",
            "액자", "화분", "전등", "전구", "스위치", "콘센트", "냉장고", "세탁기", "청소기", "선풍기",
            "주전자", "냄비", "접시", "그릇", "수저", "젓가락", "숟가락", "포크", "뚜껑", "쟁반",
            "도마", "가위", "망치", "드라이버", "빗자루", "걸레", "수건", "비누", "치약", "칫솔",
            "샴푸", "화장지", "쓰레기", "빨래", "청소", "방석", "커튼", "장갑", "양말", "신발",
            "구두", "운동화", "우산", "모자", "안경", "지갑", "가방", "허리띠", "목걸이", "반지",
            // 학교 · 문구
            "연필", "지우개", "볼펜", "색연필", "크레용", "물감", "도화지", "공책", "교과서", "사전",
            "지도", "필통", "학교", "교실", "칠판", "분필", "운동장", "도서관", "강당", "기숙사",
            "선생", "학생", "친구", "숙제", "시험", "성적", "공부", "수업", "방학", "졸업",
            "입학", "학년", "반장", "급식", "교장", "교문", "조회", "수학", "국어", "영어",
            // 사람 · 직업 · 가족
            "의사", "간호사", "약사", "교사", "교수", "변호사", "판사", "경찰", "소방관", "군인",
            "농부", "어부", "요리사", "가수", "배우", "화가", "작가", "기자", "사진사", "운전사",
            "미용사", "목수", "학자", "과학자", "발명가", "감독", "심판", "사장", "직원", "손님",
            "이웃", "가족", "부모", "아버지", "어머니", "형제", "자매", "누나", "언니", "오빠",
            "동생", "아들", "손자", "조카", "사촌", "이모", "고모", "삼촌", "할머니", "할아버지",
            "아기", "어린이", "청년", "노인", "어른", "주인", "제자", "동료", "선배", "후배",
            // 몸
            "머리", "얼굴", "이마", "눈썹", "눈동자", "입술", "이빨", "어깨", "팔꿈치", "손목",
            "손바닥", "손가락", "손톱", "가슴", "배꼽", "허리", "엉덩이", "다리", "무릎", "발목",
            "발바닥", "발가락", "피부", "머리카락", "수염", "심장", "근육", "눈물", "목소리", "숨결",
            // 교통 · 도시
            "자전거", "오토바이", "자동차", "버스", "택시", "트럭", "기차", "지하철", "전철", "비행기",
            "여객선", "잠수함", "우주선", "열기구", "도로", "골목", "거리", "터널", "신호등", "횡단보도",
            "정류장", "공항", "항구", "주차장", "시장", "상점", "백화점", "편의점", "은행", "우체국",
            "병원", "약국", "미용실", "빵집", "카페", "식당", "호텔", "극장", "공원", "놀이터",
            "동물원", "수족관", "박물관", "미술관", "체육관", "수영장", "경기장", "마을", "고향", "도시",
            // 취미 · 운동 · 물건
            "노래", "음악", "그림", "사진", "영화", "연극", "만화", "소설", "시집", "잡지",
            "신문", "방송", "라디오", "컴퓨터", "휴대폰", "전화", "편지", "우표", "엽서", "소포",
            "택배", "선물", "생일", "잔치", "결혼", "여행", "등산", "낚시", "야구", "축구",
            "농구", "배구", "탁구", "테니스", "골프", "수영", "달리기", "줄넘기", "태권도", "유도",
            "검도", "씨름", "마라톤", "체조", "요가", "장난감", "인형", "퍼즐", "주사위", "팽이",
            "풍선", "그네", "미끄럼틀", "시소", "연날리기", "바둑", "장기", "화투", "구슬", "딱지",
            // 생각 · 마음 · 사회
            "사랑", "행복", "희망", "용기", "노력", "도전", "성공", "실패", "후회", "기쁨",
            "슬픔", "분노", "걱정", "고민", "추억", "기억", "약속", "비밀", "진실", "거짓",
            "정직", "친절", "배려", "양보", "예절", "인사", "감사", "칭찬", "격려", "위로",
            "우정", "신뢰", "평화", "자유", "평등", "정의", "규칙", "질서", "책임", "의무",
            "권리", "시간", "공간", "세월", "운명", "인생", "하루", "주말", "휴일", "명절",
            "전통", "문화", "역사", "예술", "과학", "미술", "체육", "지리", "철학", "경제",
            "정치", "법률", "종교", "교육", "봉사", "취미", "직업", "회사", "가게", "농사",
            // 두음법칙에 쓰이는 ㄹ / ㄴ / ㅇ 시작 단어 (끝말잇기가 막히지 않게)
            "라일락", "나무늘보", "나침반", "나팔꽃", "낙엽", "난로", "냇물", "노트",
            "누룽지", "느티나무", "니트", "이야기", "이사", "이불장", "여행가방", "연기",
            "열매나무", "영화관", "요리", "유리", "육상", "윤활유", "율동", "임무", "입장",
            "야구장", "약수", "양배추", "얼음물", "엄지", "여권", "역사책", "예술가",
            "리본", "리듬", "레몬", "로켓", "루비", "리모컨", "린스", "리코더",
            // 기타 흔한 명사
            "물병", "종이", "봉투", "상자", "바구니", "지팡이", "부채", "향수", "양초", "성냥",
            "국기", "깃발", "지폐", "동전", "저금통", "영수증", "명함", "수첩", "달항아리", "항아리",
            "그릇장", "장독", "부엌", "화장실", "거실", "안방", "옥상", "지하실", "창고", "차고",
            "벽지", "장판", "문턱", "손잡이", "경비실", "우편함", "쓰레받기", "물걸레", "행주", "냉동실"
    };

    /** 빠른 조회용 (중복 자동 제거) */
    private static final HashSet<String> SET = new HashSet<String>();
    /** 순서 있는 목록 (랜덤 추출용) */
    private static final ArrayList<String> LIST = new ArrayList<String>();

    static {
        for (int i = 0; i < WORDS.length; i++) {
            String w = clean(WORDS[i]);
            if (w.length() < 2 || w.length() > 5) continue;   // 이상한 항목은 아예 안 쓴다
            if (!hangul(w)) continue;
            if (SET.add(w)) LIST.add(w);
        }
    }

    // ── 조회 ──────────────────────────────────────────────────────────────────

    /** 사전에 실린 단어 수 */
    public static int size() {
        return LIST.size();
    }

    /** 사전에 있는 단어인가 (앞뒤 공백은 무시) */
    public static boolean has(String w) {
        if (w == null) return false;
        return SET.contains(clean(w));
    }

    /** 아무 단어나 하나 (사전이 비었으면 null) */
    public static String random() {
        if (LIST.isEmpty()) return null;
        return LIST.get(RND.nextInt(LIST.size()));
    }

    /**
     * 게임 시작 단어. 끝 글자로 이어갈 단어가 남아있는 걸 골라준다(바로 막히면 재미없다).
     * 못 찾으면 아무 단어나 돌려준다.
     */
    public static String startWord(Set<String> used) {
        if (LIST.isEmpty()) return null;
        for (int tries = 0; tries < 60; tries++) {
            String w = LIST.get(RND.nextInt(LIST.size()));
            if (used != null && used.contains(w)) continue;
            if (anyStarting(tail(w), used)) return w;
        }
        return random();
    }

    /**
     * 그 글자(두음 변형 포함)로 시작하는 미사용 단어를 랜덤으로 하나. 없으면 null.
     * 가능하면 "그 단어 다음으로도 이어갈 수 있는" 단어를 골라준다.
     */
    public static String nextStarting(char first, Set<String> used) {
        List<String> cand = candidates(first, used);
        if (cand.isEmpty()) return null;
        // 한 번 섞어서 앞에서부터 보되, 막다른 단어는 뒤로 미룬다
        shuffle(cand);
        for (int i = 0; i < cand.size(); i++) {
            String w = cand.get(i);
            HashSet<String> after = new HashSet<String>();
            if (used != null) after.addAll(used);
            after.add(w);
            if (anyStarting(tail(w), after)) return w;
        }
        return cand.get(0);
    }

    /** 그 글자로 시작하는 미사용 단어가 하나라도 있나 */
    public static boolean anyStarting(char first, Set<String> used) {
        char[] vs = variants(first);
        for (int i = 0; i < LIST.size(); i++) {
            String w = LIST.get(i);
            if (used != null && used.contains(w)) continue;
            char h = w.charAt(0);
            for (int j = 0; j < vs.length; j++) {
                if (h == vs[j]) return true;
            }
        }
        return false;
    }

    /** 그 글자로 시작하는 미사용 단어 전부 */
    public static List<String> candidates(char first, Set<String> used) {
        ArrayList<String> out = new ArrayList<String>();
        char[] vs = variants(first);
        for (int i = 0; i < LIST.size(); i++) {
            String w = LIST.get(i);
            if (used != null && used.contains(w)) continue;
            char h = w.charAt(0);
            for (int j = 0; j < vs.length; j++) {
                if (h == vs[j]) { out.add(w); break; }
            }
        }
        return out;
    }

    // ── 끝말잇기 판정 ─────────────────────────────────────────────────────────

    /** 단어의 끝 글자 (빈 문자열이면 0) */
    public static char tail(String w) {
        String s = clean(w);
        if (s.length() == 0) return 0;
        return s.charAt(s.length() - 1);
    }

    /** 단어의 첫 글자 (빈 문자열이면 0) */
    public static char head(String w) {
        String s = clean(w);
        if (s.length() == 0) return 0;
        return s.charAt(0);
    }

    /** prev 다음에 next 를 놓을 수 있나 (두음법칙 허용) */
    public static boolean linkable(String prev, String next) {
        char t = tail(prev);
        char h = head(next);
        if (t == 0 || h == 0) return false;
        char[] vs = variants(t);
        for (int i = 0; i < vs.length; i++) {
            if (h == vs[i]) return true;
        }
        return false;
    }

    /**
     * 두음법칙으로 서로 이어받을 수 있는 글자들 (자기 자신 포함).
     *   려 → 려·녀·여   (ㅑㅒㅕㅖㅛㅠㅣ 계열은 ㄹ·ㄴ·ㅇ 모두 허용)
     *   라 → 라·나       (그 밖의 모음은 ㄹ·ㄴ 만)
     * 한글 음절이 아니거나 초성이 ㄹ/ㄴ/ㅇ 이 아니면 자기 자신만 돌려준다.
     */
    public static char[] variants(char c) {
        if (!syllable(c)) return new char[] { c };
        int ch = cho(c);
        int ju = jung(c);
        int jo = jong(c);
        boolean yi = isYi(ju);
        if (ch == CHO_R || ch == CHO_N) {
            if (yi) {
                return new char[] {
                        make(CHO_R, ju, jo), make(CHO_N, ju, jo), make(CHO_O, ju, jo)
                };
            }
            return new char[] { make(CHO_R, ju, jo), make(CHO_N, ju, jo) };
        }
        if (ch == CHO_O && yi) {
            return new char[] {
                    make(CHO_O, ju, jo), make(CHO_R, ju, jo), make(CHO_N, ju, jo)
            };
        }
        return new char[] { c };
    }

    /** 두음 변형을 사람이 읽을 수 있게 ("려 / 여 / 녀") */
    public static String variantsText(char c) {
        char[] vs = variants(c);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < vs.length; i++) {
            if (i > 0) sb.append(" / ");
            sb.append(vs[i]);
        }
        return sb.toString();
    }

    /** 전부 한글 음절로만 된 문자열인가 (공백·영문·숫자·이모지가 섞이면 false) */
    public static boolean hangul(String w) {
        if (w == null || w.length() == 0) return false;
        for (int i = 0; i < w.length(); i++) {
            if (!syllable(w.charAt(i))) return false;
        }
        return true;
    }

    // ── 한글 음절 계산 ────────────────────────────────────────────────────────

    public static boolean syllable(char c) {
        return c >= BASE && c <= LAST;
    }

    private static int cho(char c) { return (c - BASE) / (21 * 28); }

    private static int jung(char c) { return ((c - BASE) % (21 * 28)) / 28; }

    private static int jong(char c) { return (c - BASE) % 28; }

    private static char make(int cho, int jung, int jong) {
        return (char) (BASE + (cho * 21 + jung) * 28 + jong);
    }

    private static boolean isYi(int jung) {
        for (int i = 0; i < YI.length; i++) {
            if (YI[i] == jung) return true;
        }
        return false;
    }

    private static String clean(String w) {
        if (w == null) return "";
        String s = w.trim();
        // 가운데 공백은 끝말잇기 단어로 인정하지 않으니 그대로 둔다 (hangul() 에서 걸린다)
        return s;
    }

    private static void shuffle(List<String> list) {
        for (int i = list.size() - 1; i > 0; i--) {
            int j = RND.nextInt(i + 1);
            String tmp = list.get(i);
            list.set(i, list.get(j));
            list.set(j, tmp);
        }
    }
}
