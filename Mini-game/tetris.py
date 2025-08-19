import pygame
import random

# 游戏设置
SCREEN_WIDTH, SCREEN_HEIGHT = 800, 600
GRID_WIDTH, GRID_HEIGHT = 10, 20
BLOCK_SIZE = 30
GAME_WIDTH = GRID_WIDTH * BLOCK_SIZE
GAME_HEIGHT = GRID_HEIGHT * BLOCK_SIZE
SIDEBAR_WIDTH = SCREEN_WIDTH - GAME_WIDTH
BG_COLOR = (0, 0, 0)
GRID_COLOR = (30, 30, 30)
BLOCK_COLORS = [
    (0, 255, 255),  # I
    (0, 0, 255),    # J
    (255, 165, 0),  # L
    (255, 255, 0),  # O
    (0, 255, 0),    # S
    (128, 0, 128),  # T
    (255, 0, 0)     # Z
]
INITIAL_SPEED = 500  # 毫秒
ACCELERATION = 50    # 难度增加速度（毫秒）
current_index = 0   # 0~6 分别对应 I,J,L,O,S,T,Z

# 方块形状定义
SHAPES = [
    [[1, 1, 1, 1]],                      # I
    [[1, 0, 0],
     [1, 1, 1]],                         # J
    [[0, 0, 1],
     [1, 1, 1]],                         # L
    [[1, 1],
     [1, 1]],                            # O
    [[0, 1, 1],
     [1, 1, 0]],                         # S
    [[0, 1, 0],
     [1, 1, 1]],                         # T
    [[1, 1, 0],
     [0, 1, 1]]                          # Z
]

# 初始化Pygame
pygame.init()
screen = pygame.display.set_mode((SCREEN_WIDTH, SCREEN_HEIGHT))
pygame.display.set_caption("俄罗斯方块")
clock = pygame.time.Clock()

# 游戏状态
game_grid = [[0 for _ in range(GRID_WIDTH)] for _ in range(GRID_HEIGHT)]
current_piece = None
next_piece = None
score = 0
speed = INITIAL_SPEED
game_over = False
paused = False

def new_piece():
    global current_piece, next_piece, current_index, next_index
    if next_piece is None:          # 第一次
        next_index = random.randrange(len(SHAPES))
        next_piece = SHAPES[next_index]
    current_index = next_index
    current_piece = next_piece
    next_index = random.randrange(len(SHAPES))
    next_piece = SHAPES[next_index]
    x = GRID_WIDTH // 2 - len(current_piece[0]) // 2
    y = 0
    return current_piece, x, y, current_index

def rotate_piece(piece):
    return [list(row) for row in zip(*piece[::-1])]

def collision检测(piece, offset):
    off_x, off_y = offset
    for y, row in enumerate(piece):
        for x, cell in enumerate(row):
            try:
                if cell and game_grid[y + off_y][x + off_x]:
                    return True
            except IndexError:
                return True
    return False

def clear_rows():
    global score
    full_rows = [i for i, row in enumerate(game_grid) if all(row)]
    for row_index in full_rows:
        del game_grid[row_index]
        game_grid.insert(0, [0] * GRID_WIDTH)
    score += {1: 100, 2: 300, 3: 600, 4: 1000}.get(len(full_rows), 100 * len(full_rows))

def draw_grid():
    for i in range(GRID_HEIGHT):
        for j in range(GRID_WIDTH):
            color = BLOCK_COLORS[game_grid[i][j] - 1] if game_grid[i][j] else GRID_COLOR
            pygame.draw.rect(screen, color, (j * BLOCK_SIZE, i * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE), 0)
            pygame.draw.rect(screen, BG_COLOR, (j * BLOCK_SIZE, i * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE), 1)

def draw_piece(piece, offset, idx):
    off_x, off_y = offset
    color = BLOCK_COLORS[idx]
    for y, row in enumerate(piece):
        for x, cell in enumerate(row):
            if cell:
                pygame.draw.rect(screen, color,
                                 (off_x + x * BLOCK_SIZE, off_y + y * BLOCK_SIZE,
                                  BLOCK_SIZE, BLOCK_SIZE), 0)
                pygame.draw.rect(screen, BG_COLOR,
                                 (off_x + x * BLOCK_SIZE, off_y + y * BLOCK_SIZE,
                                  BLOCK_SIZE, BLOCK_SIZE), 1)

def draw_sidebar():
    font = pygame.font.SysFont('Arial', 24)
    text = font.render(f'Score: {score}', True, (255, 255, 255))
    screen.blit(text, (GAME_WIDTH + 10, 10))
    text = font.render('Next:', True, (255, 255, 255))
    screen.blit(text, (GAME_WIDTH + 10, 50))
    draw_piece(next_piece, (GAME_WIDTH + 10, 100), next_index)

def game_over_screen():
    font = pygame.font.SysFont('Arial', 48)
    text = font.render('Game Over', True, (255, 255, 255))
    text_rect = text.get_rect(center=(SCREEN_WIDTH // 2, SCREEN_HEIGHT // 2))
    screen.blit(text, text_rect)
    font = pygame.font.SysFont('Arial', 24)
    text = font.render(f'Score: {score}', True, (255, 255, 255))
    text_rect = text.get_rect(center=(SCREEN_WIDTH // 2, SCREEN_HEIGHT // 2 + 50))
    screen.blit(text, text_rect)
    text = font.render('Press R to restart', True, (255, 255, 255))
    text_rect = text.get_rect(center=(SCREEN_WIDTH // 2, SCREEN_HEIGHT // 2 + 100))
    screen.blit(text, text_rect)

# 游戏循环
current_piece, x, y, current_index = new_piece()
last_fall_time = pygame.time.get_ticks()
while True:
    screen.fill(BG_COLOR)
    draw_grid()
    draw_piece(current_piece, (x * BLOCK_SIZE, y * BLOCK_SIZE), current_index)
    draw_sidebar()

    if game_over:
        game_over_screen()
        pygame.display.update()
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                pygame.quit()
                sys.exit()
            if event.type == pygame.KEYDOWN and event.key == pygame.K_r:
                game_grid = [[0 for _ in range(GRID_WIDTH)] for _ in range(GRID_HEIGHT)]
                current_piece, x, y = new_piece()
                score = 0
                speed = INITIAL_SPEED
                game_over = False
                paused = False
        continue

    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            pygame.quit()
            sys.exit()
        if event.type == pygame.KEYDOWN:
            if event.key == pygame.K_LEFT:
                if not collision检测(current_piece, (x - 1, y)):
                    x -= 1
            elif event.key == pygame.K_RIGHT:
                if not collision检测(current_piece, (x + 1, y)):
                    x += 1
            elif event.key == pygame.K_DOWN:
                if not collision检测(current_piece, (x, y + 1)):
                    y += 1
            elif event.key == pygame.K_UP:
                rotated_piece = rotate_piece(current_piece)
                if not collision检测(rotated_piece, (x, y)):
                    current_piece = rotated_piece
            elif event.key == pygame.K_SPACE:
                paused = not paused

    if paused:
        pygame.display.update()
        clock.tick(10)
        continue

    current_time = pygame.time.get_ticks()
    if current_time - last_fall_time >= speed:
        if not collision检测(current_piece, (x, y + 1)):
            y += 1
        else:
            for i, row in enumerate(current_piece):
                for j, cell in enumerate(row):
                    if cell:
                        game_grid[y + i][x + j] = current_index + 1
            clear_rows()
            current_piece, x, y, current_index = new_piece()
            if collision检测(current_piece, (x, y)):
                game_over = True
        last_fall_time = current_time

    pygame.display.update()
    clock.tick(60)